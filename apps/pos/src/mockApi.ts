import {
  Discount,
  Operator,
  Wristband,
  Member,
  SavedChild,
  TierVerification,
  CartLine,
  CustomerTier,
  Booking,
  BookingEventPass,
  Sale,
  FnbOrder,
  FnbOrderLine,
  MerchOrder,
  MerchItem,
  MerchStockAdjustment,
  RestockLogEntry,
  INVENTORY_DEFAULT_VARIANT_ID,
  Refund,
  ReprintEvent,
  Extension,
  TxnSummary,
  WristbandActivity,
  MemberActivity,
  FloorReport,
  LiveOccupancy,
  GateEvent,
  EndOfDay,
  ReconLine,
  TxnKind,
  TxnStatus,
  PartyBooking,
  PartyExtraCharge,
  PartyPayment,
  PartyPaymentMethod,
  OtoEvent,
  EventAttendee,
  EventAttendeeCheckin,
  EventType,
  Nanny,
  CheckIn,
  Guardian,
  GuardianSource,
  AuthorizedPickup,
  AuthorizedPickupSource,
  DropOffServiceType,
  SupervisionWaiver,
  WaMessage,
  WaTemplate,
  MessageStatus,
  StockTransfer,
  StockTakeRecord,
  PurchaseOrder,
  PurchaseOrderLine,
  PurchaseOrderState,
  ContactChannel,
  BenefitProfile,
  BenefitAuditEntry,
} from './types';
import { buildSale, buildCreditGrants, buildPersonGrants } from './lib/sale';
import { computePartyOutstanding } from './lib/party';
import { recomputeEndOfDay, DEFAULT_FLOAT_THB } from './lib/endOfDay';
import { normalizePaymentMethod, paymentMethodKind } from './lib/payments';
import { normalizePhone } from './lib/phoneUtils';
import { resolveRateToday } from './lib/pricingMode';
import {
  benefitPeriodKey,
  resolveEffectiveBenefitProfile,
  applyStaffBenefits,
  emptyBenefitUsage,
  isEmptyBenefitProfile,
  BenefitUsageState,
  BenefitApplyResult,
} from './lib/benefits';
// SEAM: catalog/config getters + mutators now delegate to the single app-wide
// in-memory store (seeded from mock data; edits reset on reload, no browser
// storage by rule). Consumers still import from mockApi.ts — the swap seam is
// unchanged — but the data SOURCE is the store, so Admin edits flow to the POS.
import {
  getBranches,
  getActiveBranch,
  setActiveBranch,
  upsertBranch,
  cloneBranchCatalog,
  branchHasCatalogData,
  getTiers,
  getTier,
  getDefaultTier,
  upsertTier,
  deleteTier,
  getTicketTypes,
  getAddOns,
  getMenuItems,
  getMenuCategories,
  getMerchItems,
  getActiveMerchItems,
  getModifierGroups,
  getDiscounts,
  getDiscountReasons,
  getDropOffPricing,
  getEventDropInPricing,
  getEdcTerminals,
  getAvailableDevices,
  getTaxConfig,
  getSupervisionPolicy,
  getPrintTemplates,
  getPrintTemplate,
  upsertTicketType,
  deleteTicketType,
  upsertAddOn,
  deleteAddOn,
  upsertMenuItem,
  deleteMenuItem,
  upsertMenuCategory,
  deleteMenuCategory,
  upsertMerchItem,
  deleteMerchItem,
  adjustMerchStock,
  adjustInventoryStock,
  getInventory,
  getInventoryItem,
  upsertInventoryItem,
  deleteInventoryItem,
  upsertModifierGroup,
  deleteModifierGroup,
  upsertDiscount,
  deleteDiscount,
  incrementPromoUsage,
  setDiscountReasons,
  getPaymentMethods,
  upsertPaymentMethod,
  deletePaymentMethod,
  updateDropOffPricing,
  updateEventDropInPricing,
  updateTaxConfig,
  updateSupervisionPolicy,
  upsertEdcTerminal,
  deleteEdcTerminal,
  upsertDevice,
  deleteDevice,
  upsertPrintTemplate,
  deletePrintTemplate,
  getPricingOverrides,
  upsertPricingOverride,
  deletePricingOverride,
  getRoleBenefitTemplates,
  getRoleBenefitTemplate,
  setRoleBenefitTemplate,
  wwp,
  STOCK_LOC_BULK,
  STOCK_LOC_BOH,
  STOCK_LOC_ROT,
} from './store/catalogStore';

// Re-export the store-backed getters + mutators so the rest of the app keeps
// importing the catalog seam from mockApi.ts.
export {
  // Branch registry + active-branch seam
  getBranches,
  getActiveBranch,
  setActiveBranch,
  upsertBranch,
  cloneBranchCatalog,
  branchHasCatalogData,
  // Catalog
  getTiers,
  getTier,
  getDefaultTier,
  upsertTier,
  deleteTier,
  getTicketTypes,
  getAddOns,
  getMenuItems,
  getMenuCategories,
  getMerchItems,
  getActiveMerchItems,
  getModifierGroups,
  getDiscounts,
  getDiscountReasons,
  getDropOffPricing,
  getEventDropInPricing,
  getEdcTerminals,
  getAvailableDevices,
  getTaxConfig,
  getSupervisionPolicy,
  getPrintTemplates,
  getPrintTemplate,
  upsertTicketType,
  deleteTicketType,
  upsertAddOn,
  deleteAddOn,
  upsertMenuItem,
  deleteMenuItem,
  upsertMenuCategory,
  deleteMenuCategory,
  upsertMerchItem,
  deleteMerchItem,
  adjustMerchStock,
  getInventory,
  getInventoryItem,
  upsertInventoryItem,
  deleteInventoryItem,
  upsertModifierGroup,
  deleteModifierGroup,
  upsertDiscount,
  deleteDiscount,
  incrementPromoUsage,
  setDiscountReasons,
  getPaymentMethods,
  upsertPaymentMethod,
  deletePaymentMethod,
  updateDropOffPricing,
  updateEventDropInPricing,
  updateTaxConfig,
  updateSupervisionPolicy,
  upsertEdcTerminal,
  deleteEdcTerminal,
  upsertDevice,
  deleteDevice,
  upsertPrintTemplate,
  deletePrintTemplate,
  getPricingOverrides,
  upsertPricingOverride,
  deletePricingOverride,
  getRoleBenefitTemplates,
  getRoleBenefitTemplate,
  setRoleBenefitTemplate,
  wwp,
};

export const getDiscountByCode = (code: string): Discount | null => {
  const match = getDiscounts().find(d => d.code.toUpperCase() === code.toUpperCase());
  return match || null;
};

// In-memory wristband tabs. Balances mutate via chargeFnbCredit and reset on reload.
const mockWristbands: Wristband[] = [
  // wb-1 & wb-2 carry extra prepaid wallet credit (e.g. a birthday gift card) on
  // top of any ticket credit. It is ONE universal balance — spendable at BOTH the
  // F&B and merch stations (the guest chooses where to spend it).
  // Mama Som (adult) + Nong Fah (her kid) share one group so the gate demo works
  // out of the box: scan 1001 in/out and watch Nong Fah follow the group rule.
  { id: 'wb-1', code: '1001', customerNickname: 'Mama Som', creditBalanceTHB: 1000, gateAccess: true, groupId: 'grp-seed-fam1' },
  { id: 'wb-2', code: '1002', customerNickname: 'Nong Fah', creditBalanceTHB: 500, gateAccess: false, groupId: 'grp-seed-fam1' },
  { id: 'wb-3', code: '1003', customerNickname: 'Khun Lek', creditBalanceTHB: 50, gateAccess: true },
  { id: 'wb-4', code: '1004', customerNickname: 'Tourist Tom', creditBalanceTHB: 0, gateAccess: true },
  // Drop-off children's bands carry allergy/medical + food-consent flags pulled
  // from the drop-off form (via CheckIn). Staff-only safety info — never shown to
  // the customer. wb-5: serious allergy but cleared to order food. wb-6: parent
  // did NOT authorize food orders.
  {
    id: 'wb-5',
    code: '1005',
    customerNickname: 'Little Emma',
    creditBalanceTHB: 300,
    holderName: 'Emma Schmidt',
    allergiesMedical: 'Severe peanut allergy — EpiPen in backpack',
    foodRestrictions: 'No nuts',
    mayOrderFood: true,
    checkInId: 'ci-4',
    gateAccess: false,
  },
  {
    id: 'wb-6',
    code: '1006',
    customerNickname: 'Little Tyler',
    creditBalanceTHB: 200,
    holderName: 'Tyler Brooks',
    mayOrderFood: false,
    checkInId: 'ci-2',
    gateAccess: false,
  },
  // wb-7: prepaid_items — linked to Kai (ci-7, in_park, overdue).
  // Nuggets already served (redeemedQty=1); juice not yet redeemed. At checkout
  // the juice (฿70) is unused and will be refunded/forfeited per policy.
  {
    id: 'wb-7',
    code: '1007',
    customerNickname: 'Kai',
    creditBalanceTHB: 0,
    holderName: 'Kai Tanaka',
    mayOrderFood: true,
    checkInId: 'ci-7',
    foodProvision: {
      mode: 'prepaid_items',
      paidTHB: 190,
      items: [
        { menuItemId: 'm-nuggets', menuItemName: 'Chicken Nuggets', unitPriceTHB: 120, qty: 1, redeemedQty: 1 },
        { menuItemId: 'm-juice', menuItemName: 'Fresh Orange Juice', unitPriceTHB: 70, qty: 1, redeemedQty: 0 },
      ],
    },
    gateAccess: false,
  },
  // wb-8: prepaid_credit — linked to Mia (ci-8, in_park, due soon).
  // ฿150 loaded; ฿80 spent at the F&B station → ฿70 remaining at pickup.
  {
    id: 'wb-8',
    code: '1008',
    customerNickname: 'Mia',
    creditBalanceTHB: 70,
    holderName: 'Mia (Ananya)',
    allergiesMedical: 'Asthma — inhaler in bag',
    foodRestrictions: 'No fizzy drinks',
    mayOrderFood: true,
    checkInId: 'ci-8',
    foodProvision: {
      mode: 'prepaid_credit',
      creditAmountTHB: 150,
      paidTHB: 150,
    },
    gateAccess: false,
  },
];

// Mutable wristband store exposed for booking redemption (so issued codes can
// be pushed and become scannable at the F&B station in the same session).
export const pushWristband = (wb: import('./types').Wristband): void => {
  mockWristbands.push(wb);
};

export const getMockWristbands = (): Wristband[] => mockWristbands;

export const getWristbandByCode = (code: string): Wristband | null => {
  const trimmed = code.trim().toLowerCase();
  // Match on either the physical band code OR the QR voucher code — both keys
  // resolve to the same wallet (one balance, no double-spend).
  const match = mockWristbands.find(
    (w) => w.code.toLowerCase() === trimmed || (w.qrCode && w.qrCode.toLowerCase() === trimmed),
  );
  return match || null;
};

// --- Gate event store (private — occupancy only) ----------------------------
// The POS no longer exposes a gate scanning surface; gate hardware owns the
// scanning UI. This store remains so getLiveOccupancy can derive the adult
// headcount from the same gate-event log that the hardware will eventually
// write to. Until the real hardware is wired up, adults count as 0 in this
// prototype (no events are ever appended here by the POS itself).
const gateEvents: GateEvent[] = [];

/** Today's gate events for the active branch, oldest → newest. */
const gateEventsTodayForBranch = (): GateEvent[] => {
  const today = new Date().toISOString().slice(0, 10);
  const bid = getActiveBranch().id;
  return gateEvents.filter((e) => e.branchId === bid && e.at.slice(0, 10) === today);
};

/** Map wristbandId → latest gate direction today (active branch). */
const latestGateDirectionByBand = (): Map<string, 'in' | 'out'> => {
  const last = new Map<string, 'in' | 'out'>();
  for (const e of gateEventsTodayForBranch()) last.set(e.wristbandId, e.direction);
  return last;
};

/** Gate-access bands whose latest gate event today is 'in' (adults inside now). */
const getAdultsInsideNow = (): Wristband[] => {
  const last = latestGateDirectionByBand();
  const out: Wristband[] = [];
  for (const [wbId, dir] of last) {
    if (dir !== 'in') continue;
    const wb = mockWristbands.find((w) => w.id === wbId);
    if (wb) out.push(wb);
  }
  return out;
};

/**
 * Assign a QR-voucher key to the wristband (if not already set) and append a
 * `grant` ledger entry without touching `creditBalanceTHB` — the balance is
 * already set when the wristband is pushed. Called right after `pushWristband`
 * for every band that carries F&B credit from a ticket sale or prepaid food top-up.
 * Returns the assigned qrCode so the caller can include it on the printed voucher.
 */
export const initWalletLedger = (
  wristbandId: string,
  amountTHB: number,
  source: string,
  by?: string,
): string => {
  const wb = mockWristbands.find((w) => w.id === wristbandId);
  if (!wb) return '';
  if (!wb.qrCode) wb.qrCode = `QR-${wristbandId}`;
  if (!wb.ledger) wb.ledger = [];
  if (amountTHB > 0) {
    wb.ledger.push({ kind: 'grant', amountTHB, source, at: new Date().toISOString(), by });
  }
  return wb.qrCode;
};

/**
 * Mock F&B credit charge: reduces the in-memory balance by `amount` (never below 0),
 * appends a `spend` ledger entry, and returns the new balance.
 * Atomic: single decrement so band-code and QR-code paths can never double-spend.
 */
export const chargeFnbCredit = (wristbandId: string, amount: number, by?: string): number => {
  const wb = mockWristbands.find(w => w.id === wristbandId);
  if (!wb) return 0;
  const charge = Math.max(0, amount);
  wb.creditBalanceTHB = Math.max(0, wb.creditBalanceTHB - charge);
  if (!wb.ledger) wb.ledger = [];
  wb.ledger.push({ kind: 'spend', amountTHB: -charge, source: 'fnb_order', at: new Date().toISOString(), by });
  return wb.creditBalanceTHB;
};

// Prepaid item entitlements are served on the platform (SCRUM-494): the F&B
// order's prepaid lines are taken off the child's stay when the order closes
// (`apps/api/src/services/band-food.ts`, `redeemSalePrepaid`).

// --- Operators / face-scan login (mocked) ---------------------------------
// Stand-in for the HR face enrollments. In production these match the staff
// whose faces are enrolled in AWS Rekognition for the HR clock-in.
// benefitQrCode is a stable scannable token (Task #231) — a real deployment
// would encode a signed operator id; the mock just uses a readable string.
const mockOperators: Operator[] = [
  { id: 'op-1', name: 'Som (Reception)', role: 'staff', benefitRole: 'staff', benefitQrCode: 'OTO-BENEFIT-OP-1' },
  { id: 'op-2', name: 'Nok (Reception)', role: 'staff', benefitRole: 'staff', benefitQrCode: 'OTO-BENEFIT-OP-2' },
  { id: 'op-3', name: 'Khun Lek (Manager)', role: 'manager', benefitRole: 'manager', benefitQrCode: 'OTO-BENEFIT-OP-3' },
  { id: 'op-4', name: 'Khun Anan (Owner)', role: 'manager', benefitRole: 'owner', benefitQrCode: 'OTO-BENEFIT-OP-4' },
];

export const getEnrolledOperators = (): Operator[] => mockOperators;

// SEAM: in production this captures a camera frame, sends it to AWS Rekognition,
// and returns the matched enrolled employee. The mock returns the chosen operator.
export const mockFaceScan = (operatorId: string): Operator | null =>
  mockOperators.find(o => o.id === operatorId) ?? null;

// SEAM: in production this captures a camera frame and lets AWS Rekognition decide
// WHO it is — no operator id needed. The mock returns the face it "recognized".
export const mockFaceScanIdentify = (): Operator | null => mockOperators[0] ?? null;

// --- Staff benefits (Task #231): QR scan + application at F&B ------------
// Operational runtime data (usage counters, audit log) lives here, like the
// wristband ledger — the editable role templates/config live in catalogStore.
// The application ENGINE itself (lib/benefits.ts) is pure; this layer wires it
// to the operator roster, tracks periodic usage, and writes the audit trail.

/** Look up an enrolled operator by their benefit QR code payload. */
export const findOperatorByBenefitQrCode = (code: string): Operator | null =>
  mockOperators.find((o) => o.benefitQrCode === code) ?? null;

// Simple pub/sub so Admin's Staff Benefits panel re-renders after editing an
// operator's benefit role/override (mirrors catalogStore's subscribe pattern,
// scoped to this in-memory operator roster — no browser storage, per rule).
const _operatorListeners = new Set<() => void>();
export function subscribeOperators(cb: () => void): () => void {
  _operatorListeners.add(cb);
  return () => { _operatorListeners.delete(cb); };
}
function notifyOperators(): void {
  _operatorListeners.forEach((l) => l());
}

/** Admin edit: assign a benefit role and/or set a per-operator profile override. */
export const updateOperatorBenefits = (
  operatorId: string,
  patch: Partial<Pick<Operator, 'benefitRole' | 'benefitProfileOverride'>>
): void => {
  const idx = mockOperators.findIndex((o) => o.id === operatorId);
  if (idx === -1) return;
  mockOperators[idx] = { ...mockOperators[idx], ...patch };
  notifyOperators();
};

/** An operator's effective benefit profile: role template + per-op override. */
export const getEffectiveBenefitProfile = (operator: Operator): BenefitProfile => {
  const template = operator.benefitRole ? getRoleBenefitTemplate(operator.benefitRole) : undefined;
  return resolveEffectiveBenefitProfile(template?.profile, operator.benefitProfileOverride);
};

// Usage keyed by `${operatorId}:${benefitKind}:${periodKey}` — e.g.
// "op-1:credit:2026-07" or "op-1:free:coffee:2026-07-03". Reset "by period"
// falls out naturally: a new period key just starts at zero.
const _benefitUsage = new Map<string, number>();

function usageKey(operatorId: string, kind: 'credit' | 'free', period: string, benefitId?: string): string {
  return benefitId ? `${operatorId}:${kind}:${benefitId}:${period}` : `${operatorId}:${kind}:${period}`;
}

/** Current-period usage snapshot for an operator's profile (for the engine + UI). */
export const getBenefitUsage = (operator: Operator, profile: BenefitProfile = getEffectiveBenefitProfile(operator)): BenefitUsageState => {
  const usage = emptyBenefitUsage();
  for (const fi of profile.freeItems ?? []) {
    const key = usageKey(operator.id, 'free', benefitPeriodKey(fi.period), fi.id);
    usage.freeItemsUsed[fi.id] = _benefitUsage.get(key) ?? 0;
  }
  if (profile.credit) {
    const key = usageKey(operator.id, 'credit', benefitPeriodKey(profile.credit.period));
    usage.creditUsedTHB = _benefitUsage.get(key) ?? 0;
  }
  return usage;
};

function commitBenefitUsageDeltas(operator: Operator, profile: BenefitProfile, result: BenefitApplyResult): void {
  for (const delta of result.freeItemUsageDeltas) {
    const benefit = profile.freeItems?.find((fi) => fi.id === delta.benefitId);
    if (!benefit) continue;
    const key = usageKey(operator.id, 'free', benefitPeriodKey(benefit.period), benefit.id);
    _benefitUsage.set(key, (_benefitUsage.get(key) ?? 0) + delta.qtyUsed);
  }
  if (result.creditUsedDelta > 0 && profile.credit) {
    const key = usageKey(operator.id, 'credit', benefitPeriodKey(profile.credit.period));
    _benefitUsage.set(key, (_benefitUsage.get(key) ?? 0) + result.creditUsedDelta);
  }
}

const _benefitAuditLog: BenefitAuditEntry[] = [];

export const getBenefitAuditLog = (): BenefitAuditEntry[] =>
  [..._benefitAuditLog].sort((a, b) => b.at.localeCompare(a.at));

/**
 * Preview what a scanned operator's benefit would do to a set of F&B lines,
 * WITHOUT committing usage or writing the audit log. Used to show the staff
 * till operator the relief breakdown before they finalize the order.
 */
export const previewStaffBenefit = (
  scannedOperator: Operator,
  lines: FnbOrderLine[]
): BenefitApplyResult => {
  const profile = getEffectiveBenefitProfile(scannedOperator);
  if (isEmptyBenefitProfile(profile)) {
    return { compedTHB: 0, freeItemsTHB: 0, creditTHB: 0, discountTHB: 0, totalReliefTHB: 0, freeItemUsageDeltas: [], creditUsedDelta: 0 };
  }
  const usage = getBenefitUsage(scannedOperator, profile);
  return applyStaffBenefits(profile, usage, lines);
};

/**
 * Commit a benefit application: consumes the period usage and writes an audit
 * entry. Called once, at order confirmation, after the till operator has
 * accepted the previewed relief. `orderId`/`branchId` are attached once the
 * order is actually finalized (recordFnbOrder stamps the audit entry's id
 * onto FnbOrder.staffBenefit).
 */
export const commitStaffBenefit = (
  scannedOperator: Operator,
  processedBy: Operator,
  lines: FnbOrderLine[],
  branchId?: string
): { auditId: string; result: BenefitApplyResult } | null => {
  const profile = getEffectiveBenefitProfile(scannedOperator);
  if (isEmptyBenefitProfile(profile)) return null;
  const usage = getBenefitUsage(scannedOperator, profile);
  const result = applyStaffBenefits(profile, usage, lines);
  if (result.totalReliefTHB <= 0) return null;

  commitBenefitUsageDeltas(scannedOperator, profile, result);

  const entry: BenefitAuditEntry = {
    id: `bnf-${Date.now()}-${Math.round(Math.random() * 1000)}`,
    at: new Date().toISOString(),
    scannedOperatorId: scannedOperator.id,
    scannedOperatorName: scannedOperator.name,
    benefitRole: scannedOperator.benefitRole ?? 'staff',
    processedById: processedBy.id,
    processedByName: processedBy.name,
    isComp: result.compedTHB > 0,
    compedTHB: result.compedTHB,
    freeItemsTHB: result.freeItemsTHB,
    creditTHB: result.creditTHB,
    discountTHB: result.discountTHB,
    totalReliefTHB: result.totalReliefTHB,
    branchId,
  };
  _benefitAuditLog.push(entry);
  return { auditId: entry.id, result };
};

/** Stamp the order id onto an already-written audit entry once the order is finalized. */
export const attachBenefitAuditOrderId = (auditId: string, orderId: string): void => {
  const entry = _benefitAuditLog.find((e) => e.id === auditId);
  if (entry) entry.orderId = orderId;
};

// --- Per-operator theme preferences (in-memory; survives lock/unlock within a
// session but resets on full page reload — no browser storage, per hard rules) ---
type OperatorThemePref = { staff: 'dark' | 'light'; customer: 'dark' | 'light' };
const _operatorThemePrefs = new Map<string, OperatorThemePref>();

export const getOperatorThemePref = (operatorId: string): OperatorThemePref | null =>
  _operatorThemePrefs.get(operatorId) ?? null;

export const setOperatorThemePref = (
  operatorId: string,
  staff: 'dark' | 'light',
  customer: 'dark' | 'light',
): void => { _operatorThemePrefs.set(operatorId, { staff, customer }); };

// Inactivity timings moved to src/auth/timings.ts (S2-01a): a security
// control does not belong in the prototype's fixture module.

// --- Members / verified pricing tier (mocked) -----------------------------
// A member's discounted tier is a VERIFIED attribute.
// `tourist` is the full-price default and never needs proof. In production
// these live in the CRM; verifications are stamped with the face-login operator.
const seedVerification = (
  tier: 'expat' | 'thai',
  proofType: string
): TierVerification => ({
  tier,
  proofType,
  verifiedBy: 'Enrolment',
  verifiedById: 'system',
  verifiedAt: '2026-01-01T00:00:00.000Z',
});

const mockMembers: Member[] = [
  // Verified local (residence cert). A returning family — seeded with saved
  // children so the pre-fill/re-confirm flow has data to demo on a known phone
  // (prototype, in-memory only).
  {
    id: 'mem-1',
    phone: '+66811111111',
    nickname: 'Mali',
    tierVerification: seedVerification('thai', 'Residence certificate'),
    savedChildren: [
      {
        id: 'sc-seed-1',
        childName: 'Nong Ploy',
        childAge: 5,
        allergiesMedical: 'Peanut allergy — carries an EpiPen',
        foodRestrictions: 'No pork',
        savedAt: '2026-03-01T09:00:00.000Z',
        updatedAt: '2026-03-01T09:00:00.000Z',
        savedBy: 'Enrolment',
      },
      {
        id: 'sc-seed-2',
        childName: 'Nong Tan',
        childAge: 7,
        savedAt: '2026-03-01T09:00:00.000Z',
        updatedAt: '2026-03-01T09:00:00.000Z',
        savedBy: 'Enrolment',
      },
    ],
  },
  // Verified expat (passport).
  {
    id: 'mem-2',
    phone: '+66822222222',
    nickname: 'James',
    tierVerification: seedVerification('expat', 'Passport'),
  },
  // Verified local (residence cert).
  {
    id: 'mem-3',
    phone: '+66833333333',
    nickname: 'Siti',
    tierVerification: seedVerification('thai', 'Residence certificate'),
  },
  // No verification — tourist rate.
  {
    id: 'mem-4',
    phone: '+66844444444',
    nickname: 'Alex',
  },
];

export const getMembers = (): Member[] => mockMembers;

// Look up a member by phone (nickname is an optional extra hint, not required).
export const getMemberByPhone = (phone: string, _nickname?: string): Member | null => {
  const needle = normalizePhone(phone);
  if (!needle) return null;
  return mockMembers.find((m) => normalizePhone(m.phone) === needle) ?? null;
};

export const getMemberById = (id: string): Member | null =>
  mockMembers.find((m) => m.id === id) ?? null;

// Lightweight in-memory member creation (for verify-on-the-spot with no profile yet).
export const createMember = (phone: string, nickname: string, preferredChannel?: ContactChannel): Member => {
  const member: Member = {
    id: `mem-${Math.random().toString(36).substring(2, 8)}`,
    phone: phone.trim(),
    nickname: nickname.trim(),
    preferredChannel,
  };
  mockMembers.push(member);
  return member;
};

// Write a verified tier onto a member's profile (mutates in-memory, resets on
// reload). A real backend persists this to the CRM.
export const verifyMemberTier = (
  memberId: string,
  verification: TierVerification
): Member | null => {
  const member = mockMembers.find((m) => m.id === memberId);
  if (!member) return null;
  member.tierVerification = verification;
  return member;
};

// Patch an existing member's editable fields (nickname / phone / verified tier).
// Mutates in-memory; a real backend writes to the CRM. Members are NOT on the
// reactive catalog store, so callers must re-read getMembers() after mutating
// to refresh any local list state.
export const updateMember = (
  id: string,
  patch: Partial<Pick<Member, 'phone' | 'nickname' | 'tierVerification' | 'preferredChannel'>>
): Member | null => {
  const member = mockMembers.find((m) => m.id === id);
  if (!member) return null;
  if (patch.phone !== undefined) member.phone = patch.phone.trim();
  if (patch.nickname !== undefined) member.nickname = patch.nickname.trim();
  if ('tierVerification' in patch) member.tierVerification = patch.tierVerification;
  if ('preferredChannel' in patch) member.preferredChannel = patch.preferredChannel;
  return member;
};

// Remove a member entirely (in-memory; resets on reload).
export const deleteMember = (id: string): void => {
  const idx = mockMembers.findIndex((m) => m.id === id);
  if (idx !== -1) mockMembers.splice(idx, 1);
};

// --- Saved child profiles (phone-keyed) -----------------------------------
// Reusable child details saved against a returning member so a family doesn't
// re-type everything each visit. Captured the first time a child's drop-off /
// nanny info is entered (everything EXCEPT the photo) and offered to pre-fill
// the next visit's form — re-confirmed by the parent, never silently applied.
//
// PRIVACY / BACKEND: this stores children's personal data against a phone number.
// In this prototype it lives in memory only and resets on reload. A real backend
// MUST add explicit consent records, retention limits and access control before
// persisting any of it (see BACKEND_REQUIREMENTS.md). These getters/mutators are
// the swap seam; members are NOT on the reactive catalog store, so callers must
// re-read getSavedChildren() / getMemberByPhone() after mutating.

// The editable fields a capture flow supplies (id + timestamps are stamped here).
export interface SavedChildInput {
  childName: string;
  childAge: number;
  dateOfBirth?: string;
  allergiesMedical?: string;
  dietary?: string;
  foodRestrictions?: string;
  notes?: string;
}

const cleanOptional = (v?: string): string | undefined => {
  const t = v?.trim();
  return t ? t : undefined;
};

// All children saved against a member (empty array if none / unknown member).
export const getSavedChildren = (memberId: string): SavedChild[] =>
  mockMembers.find((m) => m.id === memberId)?.savedChildren ?? [];

// Add a brand-new saved child to a member. Stamped with the operator (door) or a
// caller-supplied label (e.g. 'Online booking') plus save/update timestamps.
export const addSavedChild = (
  memberId: string,
  input: SavedChildInput,
  savedBy?: string,
): SavedChild | null => {
  const member = mockMembers.find((m) => m.id === memberId);
  if (!member) return null;
  const now = new Date().toISOString();
  const child: SavedChild = {
    id: `sc-${Math.random().toString(36).substring(2, 9)}`,
    childName: input.childName.trim(),
    childAge: input.childAge,
    dateOfBirth: cleanOptional(input.dateOfBirth),
    allergiesMedical: cleanOptional(input.allergiesMedical),
    dietary: cleanOptional(input.dietary),
    foodRestrictions: cleanOptional(input.foodRestrictions),
    notes: cleanOptional(input.notes),
    savedAt: now,
    updatedAt: now,
    savedBy: savedBy?.trim() || undefined,
  };
  if (!member.savedChildren) member.savedChildren = [];
  member.savedChildren.push(child);
  return child;
};

// Patch an existing saved child (e.g. the parent edited a field or re-confirmed a
// grown-up age on return). Bumps updatedAt. Returns null if not found.
export const updateSavedChild = (
  memberId: string,
  childId: string,
  patch: SavedChildInput,
): SavedChild | null => {
  const member = mockMembers.find((m) => m.id === memberId);
  const child = member?.savedChildren?.find((c) => c.id === childId);
  if (!child) return null;
  child.childName = patch.childName.trim();
  child.childAge = patch.childAge;
  child.dateOfBirth = cleanOptional(patch.dateOfBirth);
  child.allergiesMedical = cleanOptional(patch.allergiesMedical);
  child.dietary = cleanOptional(patch.dietary);
  child.foodRestrictions = cleanOptional(patch.foodRestrictions);
  child.notes = cleanOptional(patch.notes);
  child.updatedAt = new Date().toISOString();
  return child;
};

// Delete a saved child from a member's profile (in-memory; resets on reload).
export const removeSavedChild = (memberId: string, childId: string): void => {
  const member = mockMembers.find((m) => m.id === memberId);
  if (!member?.savedChildren) return;
  member.savedChildren = member.savedChildren.filter((c) => c.id !== childId);
};

// Proof types staff can record when verifying a discounted tier. 'Other'
// prompts for a short description of the document (saved with the record).
export const getProofTypes = (): string[] => [
  'Passport',
  'Residence certificate',
  'School card',
  'Other',
];

/**
 * How many places reference a tier id — ticket price entries, member
 * verifications and recorded ticket sales. Admin uses this to block deleting a
 * tier that history or pricing still depends on. Front-end only.
 */
export const countTierUsage = (id: string): number => {
  let count = 0;
  for (const t of getTicketTypes()) {
    if (t.prices[id] !== undefined) count++;
  }
  for (const m of mockMembers) {
    if (m.tierVerification?.tier === id) count++;
  }
  for (const s of recordedSales) {
    if (s.tier === id) count++;
  }
  return count;
};

// The venue's PromptPay receiving number (mock). A real deployment would read
// this from venue/merchant config; it's the payee the booking QR pays into.
export const getVenuePromptPayId = (): string => '0812345678';

// --- Customer self-booking + in-park redemption ---------------------------
// A booking is a paid order + QR captured online before arrival. Bookings
// are persisted in-memory so reception can redeem them by scanning the QR.
interface CreateBookingParams {
  memberId?: string;
  tier: CustomerTier;
  lines: CartLine[];
  promoDiscount?: Discount;
  total: number;
  paymentMethod: string;
  // Parent identity for any drop-off children booked online (the booking-level
  // consent signer). Required only when the cart contains drop-off lines.
  registrant?: {
    parentName: string;
    phone: string;
    contactMethod?: ContactChannel;
    // Confirmations checklist ticked on /book — stamped on the booking (and
    // mirrored onto each drop-off/nanny child's CheckIn) regardless of whether
    // the cart carries a dropOff line, since the no-fee 9+ flow has none.
    acknowledgedConfirmations?: import('./types').AcknowledgedConfirmation[];
  };
  // Event passes bought online (camp day / event entry). Each creates a
  // registered (NOT checked-in) attendee on its event; the booking records the
  // link so reception can propose event check-in at QR scan. Kept OUT of `lines`
  // so the regular-guest bracelet/drop-off/redemption paths stay untouched.
  eventPasses?: { eventId: string; input: NewEventAttendeeInput; priceTHB: number }[];
}

// In-memory bookings store (module-level so createBooking can push to it).
// Seeded lazily on first read so getTicketTypes() is guaranteed to have data.
const mockBookings: Booking[] = [];
let _bookingsSeeded = false;

function ensureBookingsSeeded(): void {
  if (_bookingsSeeded) return;
  _bookingsSeeded = true;
  const tickets = getTicketTypes();
  const t1h = tickets.find((t) => t.id === 't-1h') ?? tickets[0];
  const t2h = tickets.find((t) => t.id === 't-2h') ?? tickets[0];
  if (!t1h || !t2h) return;
  const p1h = t1h.prices['tourist'] ? resolveRateToday(t1h.prices['tourist']) : 350;
  const p2h = t2h.prices['tourist'] ? resolveRateToday(t2h.prices['tourist']) : 500;
  // Drop-off one-time service fee mirrors getDropOffPricing().oneTimeFeeTHB
  const svcFee = resolveRateToday(getDropOffPricing().oneTimeFeeTHB);

  // Booking 1 — regular guests only (2 kids + 1 adult, 2-hour play, tourist)
  mockBookings.push({
    id: 'bk-demo-reg',
    reference: 'OTO-DEMO-REG',
    tier: 'tourist',
    lines: [{
      id: 'bl-reg-1',
      ticketType: t2h,
      tier: 'tourist',
      kids: 2,
      adults: 1,
      socks: 0,
      addOns: [],
      lineTotal: p2h * 3,
    }],
    total: p2h * 3,
    paymentMethod: 'card',
    willIssue: { childBracelets: 2, adultBracelets: 1, creditTotalTHB: p2h },
    createdAt: '2026-06-27T08:00:00.000Z',
    status: 'paid',
  });

  // Booking 2 — adult + drop-off child (1-hour); registration pre-seeded as reg-bk-mix
  mockBookings.push({
    id: 'bk-demo-mix',
    reference: 'OTO-DEMO-MIX',
    tier: 'tourist',
    registrationId: 'reg-bk-mix',
    lines: [
      {
        id: 'bl-mix-1',
        ticketType: t2h,
        tier: 'tourist',
        kids: 0,
        adults: 1,
        socks: 0,
        addOns: [],
        lineTotal: p2h,
      },
      {
        id: 'bl-mix-2',
        ticketType: t1h,
        tier: 'tourist',
        kids: 1,
        adults: 0,
        socks: 0,
        addOns: [],
        lineTotal: p1h + svcFee,
        dropOff: {
          registrationId: 'reg-bk-mix',
          checkInId: 'ci-bk1',
          childName: 'Nong Saai',
          childAge: 4,
          service: 'drop_off',
          hours: t1h.hours,
          lengthChosen: true,
          serviceFeeTHB: svcFee,
          mayOrderFood: false,
        },
      },
    ],
    total: p2h + p1h + svcFee,
    paymentMethod: 'promptpay',
    willIssue: { childBracelets: 1, adultBracelets: 1, creditTotalTHB: p2h },
    createdAt: '2026-06-27T08:30:00.000Z',
    status: 'paid',
  });

  // Booking 3 — drop-off only (1 child, no regular guests); reg-bk-dop
  mockBookings.push({
    id: 'bk-demo-dop',
    reference: 'OTO-DEMO-DOP',
    tier: 'tourist',
    registrationId: 'reg-bk-dop',
    lines: [{
      id: 'bl-dop-1',
      ticketType: t1h,
      tier: 'tourist',
      kids: 1,
      adults: 0,
      socks: 0,
      addOns: [],
      lineTotal: p1h + svcFee,
      dropOff: {
        registrationId: 'reg-bk-dop',
        checkInId: 'ci-bk2',
        childName: 'Nong Pim',
        childAge: 5,
        service: 'drop_off',
        hours: t1h.hours,
        lengthChosen: true,
        serviceFeeTHB: svcFee,
        mayOrderFood: false,
      },
    }],
    total: p1h + svcFee,
    paymentMethod: 'card',
    willIssue: { childBracelets: 1, adultBracelets: 0, creditTotalTHB: 0 },
    createdAt: '2026-06-27T09:00:00.000Z',
    status: 'paid',
  });
}

export const getAllBookings = (): Booking[] => {
  ensureBookingsSeeded();
  return [...mockBookings].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
};

export const getBooking = (reference: string): Booking | null => {
  ensureBookingsSeeded();
  const upper = reference.toUpperCase().trim();
  return mockBookings.find((b) => b.reference.toUpperCase() === upper) ?? null;
};

/**
 * Mark a booking as redeemed (idempotent guard: returns null if already redeemed).
 * Records the wristband codes issued for the regular guests.
 */
export const redeemBooking = (
  reference: string,
  issuedWristbandCodes: string[],
): Booking | null => {
  ensureBookingsSeeded();
  const b = mockBookings.find(
    (bk) => bk.reference.toUpperCase() === reference.toUpperCase().trim(),
  );
  if (!b || b.status !== 'paid') return null;
  b.status = 'redeemed';
  b.redeemedAt = new Date().toISOString();
  b.issuedWristbandCodes = issuedWristbandCodes;
  return b;
};

// Convert a customer-chosen "HH:MM" wall-clock time into an ISO timestamp on the
// same calendar day as `baseISO` (the booking moment). Used to turn a nanny's
// chosen start time into the booked `scheduledFor` for the Schedule list.
const hhmmToISO = (hhmm: string, baseISO: string): string => {
  const [h, m] = hhmm.split(':').map((n) => parseInt(n, 10));
  const d = new Date(baseISO);
  if (!Number.isNaN(h) && !Number.isNaN(m)) d.setHours(h, m, 0, 0);
  return d.toISOString();
};

export const createBooking = (params: CreateBookingParams): Booking => {
  const childBracelets = params.lines.reduce((acc, l) => acc + l.kids, 0);
  const adultBracelets = params.lines.reduce((acc, l) => acc + l.adults, 0);
  // Total F&B credit this booking will grant, derived from each ticket's own
  // credit rule (adults and/or kids) — the single source in lib/sale.ts.
  const creditTotalTHB = buildCreditGrants(params.lines)
    .filter((g) => g.type === 'fnb_credit')
    .reduce((acc, g) => acc + (g.valueTHB ?? 0), 0);

  const ref = `OTO-${Math.random().toString(36).substring(2, 6).toUpperCase()}-${Math.random()
    .toString(36)
    .substring(2, 6)
    .toUpperCase()}`;

  // Determine registrationId before building the booking so it can be set on
  // the booking object (needed for in-park QR redemption → drop-off check-in).
  const dropOffLines = params.lines.filter((l) => l.dropOff);
  const registrationId = dropOffLines.length > 0
    ? `reg-${Math.random().toString(36).substring(2, 9)}`
    : undefined;

  const booking: Booking = {
    id: Math.random().toString(36).substring(2, 8).toUpperCase(),
    reference: ref,
    memberId: params.memberId,
    tier: params.tier,
    lines: params.lines,
    promoDiscount: params.promoDiscount,
    total: params.total,
    paymentMethod: params.paymentMethod,
    willIssue: { childBracelets, adultBracelets, creditTotalTHB },
    createdAt: new Date().toISOString(),
    status: 'paid',
    registrationId,
    acknowledgedConfirmations: params.registrant?.acknowledgedConfirmations,
  };

  // Persist so reception can look it up via getBooking(reference).
  mockBookings.push(booking);

  // Event passes: create a REGISTERED (not checked-in) attendee on each event so
  // the customer shows on the roster's Outstanding list as pre-booked. Reuses the
  // same addEventAttendee mutator the door uses (Events stays the source of truth);
  // online sign-up is scoped to the booking day (registerProperly:false) and never
  // checks in — that happens at reception when the booking QR is scanned. Stamped
  // with a synthetic online operator. Records the link on booking.eventPasses.
  if (params.eventPasses && params.eventPasses.length > 0) {
    const today = new Date().toISOString().slice(0, 10);
    const refs: BookingEventPass[] = [];
    for (const pass of params.eventPasses) {
      const event = getEventById(pass.eventId);
      const attendee = addEventAttendee(
        pass.eventId,
        pass.input,
        { registerProperly: false, today },
        { operatorName: 'Online booking', operatorId: 'online' },
      );
      if (!attendee) continue;
      refs.push({
        eventId: pass.eventId,
        attendeeId: attendee.id,
        eventTitle: event?.title ?? 'Event',
        attendeeName: attendee.name,
        parentAttending: !!attendee.parentAttending,
        priceTHB: pass.priceTHB,
      });
    }
    if (refs.length > 0) booking.eventPasses = refs;
  }

  // Online drop-off booking creates a registration with consent captured; check-in
  // still happens in-park (QR redeemed). For nanny bookings, the customer has chosen
  // a start time and accepted the service online; the specific nanny is assigned by
  // staff at check-in (assignment is never done online).
  if (dropOffLines.length > 0) {
    // Fail loud rather than register a child we can't reach: drop-off demands a
    // named parent + phone. The /book UI enforces this, so this guards callers.
    const registrant = params.registrant;
    if (!registrant || !registrant.parentName.trim() || !registrant.phone.trim()) {
      throw new Error('Drop-off booking requires a parent name and contact phone');
    }
    const registeredAt = booking.createdAt;
    const newChildren: CheckIn[] = [];
    for (const l of dropOffLines) {
      const d = l.dropOff!;
      // Normalize the prepaid provision exactly as the door flow does
      // (registerWalkInChildren): a prepaid mode with paidTHB <= 0 (e.g. credit
      // mode left blank, or items mode with nothing added) is treated as 'none'
      // so ordering is never authorized without payment. mayOrderFood is then
      // derived from the normalized provision when one is supplied.
      const rawFp = d.foodProvision;
      const normalizedFp: import('./types').ChildFoodProvision | undefined = rawFp
        ? rawFp.mode !== 'none' && rawFp.paidTHB <= 0
          ? { mode: 'none', paidTHB: 0 }
          : rawFp
        : undefined;
      const effectiveMayOrder = normalizedFp
        ? normalizedFp.mode !== 'none' && normalizedFp.paidTHB > 0
        : d.mayOrderFood ?? false;
      // Booked-but-not-checked-in time so the child surfaces in the drop-off
      // board's Schedule list (same place door "leave as booked" children land).
      // Nanny: the customer-chosen start time. Drop-off: the booking moment
      // (same-day prototype — no separate play-start picker). The booked play
      // length is also stamped so the overstay timer can start at check-in
      // without re-asking (mirrors markCheckInsBooked for the door path).
      const scheduledFor =
        d.service === 'nanny' && d.nannyStartTime
          ? hhmmToISO(d.nannyStartTime, booking.createdAt)
          : booking.createdAt;
      const newCi: CheckIn = {
        id: `ci-${Math.random().toString(36).substring(2, 9)}`,
        branchId: getActiveBranch().id,
        // registrationId is guaranteed set when dropOffLines.length > 0
        registrationId: registrationId!,
        childName: d.childName,
        childAge: d.childAge,
        // Persist the captured DOB so the child's age stays derivable at check-in
        // (the source of truth); childAge is the legacy fallback for old records.
        dateOfBirth: d.dateOfBirth,
        parentName: registrant.parentName,
        contactMethod: registrant.contactMethod ?? 'whatsapp',
        phone: registrant.phone,
        allergiesMedical: d.allergiesMedical,
        // Carry the food authorization and dietary restrictions captured on the booking form.
        mayOrderFood: effectiveMayOrder,
        // Persist the prepaid provision on the registration in the same shape the
        // POS reads (matching the door). The band is NOT loaded here — that is
        // deferred to check-in (QR scanned, band issued), consistent with how
        // bracelets/credit grants are deferred. At check-in makeDropOffLine reads this
        // back and checkInFamilyWithPayment loads the credit/items onto the band.
        foodProvision: normalizedFp,
        foodRestrictions: d.foodRestrictions,
        // Carry the child photo captured during online consent (if any).
        childPhotoUrl: d.childPhotoUrl,
        // The online consent checkboxes stand in as the booking's signed form.
        confirmationsAccepted: true,
        acknowledgedConfirmations: registrant.acknowledgedConfirmations,
        // Use the service type chosen online (drop_off or nanny).
        serviceType: d.service,
        // Carry the customer-chosen nanny start time so the in-park board
        // can display when coverage begins (nanny children only).
        nannyStartTime: d.service === 'nanny' ? d.nannyStartTime : undefined,
        status: 'registered',
        registeredAt,
        // Booked (paid online) but not yet checked in → Schedule list. The booked
        // play length lets the payment-free check-in start the overstay timer
        // without re-asking the length.
        scheduledFor,
        bookedDurationMinutes: Math.round(l.ticketType.hours * 60),
      };
      mockCheckIns.push(newCi);
      newChildren.push(newCi);
    }
    // Auto-send ONE WA connection check for the registration after every sibling
    // is in mockCheckIns, so the message names all children (not just the first).
    // It stamps waConnection.status = 'pending' across all siblings.
    const sender = newChildren.find((c) => c.phone.trim()) ?? newChildren[0];
    if (sender) autoSendWaConfirmation(sender);
  }

  return booking;
};

// --- Order history: in-memory transaction stores + refunds ----------------
// Completed ticket Sales and F&B orders are recorded here so staff can review
// and refund them. Module-memory only — wiped on reload, no persistence.
// In production these live in a backend ledger feeding the HR Activity Logbook
// and the discounts+refunds report.

// Seed cross-branch history for member Mali (mem-1, +66811111111) so the
// global-member feature is immediately demonstrable on first load.
// Branch-tagging is done inline (not via recordSale) to avoid touching the
// active-branch state or inventory at init time.
const _seedTicketType = {
  id: 'tt-1',
  name: '1-Hour Play',
  durationLabel: '1 hr',
  hours: 1,
  prices: { tourist: wwp(350), expat: wwp(300), thai: wwp(250) },
  active: true,
  taxableCategory: 'tickets' as const,
};

const recordedSales: Sale[] = [
  // Mali's earlier ticket sale at HKT Chalong (the other branch) so cross-branch
  // history has data to show when looking up her phone at HKT Central.
  {
    id: 'seed-chalong-s1',
    operatorId: 'op-2',
    operatorName: 'Nook',
    tier: 'thai',
    memberId: 'mem-1',
    customerPhone: '+66811111111',
    customerNickname: 'Mali',
    wristbandCode: 'chalong-wb-1',
    paymentMethod: 'cash',
    branchId: 'hkt-chalong',
    lines: [
      {
        id: 'seed-line-1',
        ticketType: _seedTicketType,
        tier: 'thai',
        kids: 2,
        adults: 0,
        socks: 0,
        addOns: [],
        lineTotal: 500,
      },
    ],
    total: 500,
    creditGrants: [],
    bracelets: { adults: 0, children: 2 },
    createdAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    status: 'paid',
    refunds: [],
    manualDiscounts: [],
  },
];
const recordedFnbOrders: FnbOrder[] = [
  // Mali's F&B order at HKT Chalong (linked via wristbandCode).
  {
    id: 'seed-chalong-f1',
    operatorId: 'op-2',
    operatorName: 'Nook',
    branchId: 'hkt-chalong',
    wristband: {
      id: 'wb-chalong-1',
      code: 'chalong-wb-1',
      customerNickname: 'Mali',
      creditBalanceTHB: 0,
      gateAccess: false, // kid band (F&B order snapshot, other branch)
    },
    lines: [],
    manualDiscounts: [],
    total: 180,
    pickupCode: 'P001',
    payment: { creditUsed: 0, cash: 180, card: 0, promptpay: 0 },
    createdAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000).toISOString(),
    status: 'paid',
    refunds: [],
  },
];
const recordedMerchOrders: MerchOrder[] = [];

/**
 * Record a completed ticket Sale and decrement inventory for any stocked
 * add-ons carried on each CartLine (including socks).
 * Sale add-ons carry variantId when the user picked a variant (e.g. socks S/M/L).
 */
export const recordSale = (sale: Sale): void => {
  recordedSales.unshift({ ...sale, branchId: getActiveBranch().id });

  // Build a lookup of AddOn definitions keyed by id so we can check inventoryItemId.
  const addOnDefs = new Map(getAddOns().map((a) => [a.id, a]));

  // Socks add-on definition (may carry inventoryItemId for variant stock).
  const socksDef = addOnDefs.get('a-socks');

  for (const line of sale.lines) {
    // 1. Per-line socks count (no variant selection in ticket flow → default variant).
    if (line.socks > 0 && socksDef?.inventoryItemId) {
      adjustInventoryStock(
        socksDef.inventoryItemId,
        INVENTORY_DEFAULT_VARIANT_ID,
        -line.socks,
      );
    }

    // 2. Stocked add-ons in the SelectedAddOn array. A multi-variant add-on
    //    (e.g. grip socks split 1×S + 2×M) carries a variantBreakdown — decrement
    //    each size's own stock; otherwise fall back to the single chosen variant.
    for (const sa of line.addOns) {
      const def = addOnDefs.get(sa.id);
      if (!def?.inventoryItemId) continue;
      if (sa.variantBreakdown && sa.variantBreakdown.length > 0) {
        for (const b of sa.variantBreakdown) {
          adjustInventoryStock(def.inventoryItemId, b.variantId, -b.quantity);
        }
      } else {
        adjustInventoryStock(
          def.inventoryItemId,
          sa.variantId ?? INVENTORY_DEFAULT_VARIANT_ID,
          -sa.quantity,
        );
      }
    }
  }
};

/**
 * S2-14b — `decrementStock: false` when the platform closed the sale: its
 * finalise took the stock off the platform's shelves, and a second, local
 * decrement of the ported inventory would be the prototype's count drifting
 * away from the real one. The record itself is still kept for the screens
 * that read this store.
 */
export interface RecordOrderOptions {
  decrementStock?: boolean;
}

export const recordFnbOrder = (order: FnbOrder, options: RecordOrderOptions = {}): void => {
  recordedFnbOrders.unshift({ ...order, branchId: getActiveBranch().id });
  if (options.decrementStock === false) return;
  // DECREMENT on-hand stock for any stock-tracked menu item (e.g. bottled water,
  // slushie flavours). Multi-variant lines carry their variantId; single-variant
  // and untracked-but-linked lines fall back to the Default variant. Prepaid
  // (already-charged) lines still consume physical stock when handed over.
  for (const line of order.lines) {
    const invId = line.menuItem.inventoryItemId;
    if (!invId) continue;
    adjustInventoryStock(invId, line.variantId ?? INVENTORY_DEFAULT_VARIANT_ID, -line.qty);
  }
};

// Record a retail/merch order and DECREMENT on-hand stock for each sold line.
// Routes through inventory (adjustInventoryStock) when the item has an
// inventoryItemId; falls back to adjustMerchStock for legacy items.
// Restored on a full refund (see recordRefund).
export const recordMerchOrder = (order: MerchOrder, options: RecordOrderOptions = {}): void => {
  recordedMerchOrders.unshift({ ...order, branchId: getActiveBranch().id });
  if (options.decrementStock === false) return;
  for (const line of order.lines) {
    if (line.merchItem.inventoryItemId) {
      adjustInventoryStock(
        line.merchItem.inventoryItemId,
        line.variantId ?? INVENTORY_DEFAULT_VARIANT_ID,
        -line.qty,
      );
    } else {
      adjustMerchStock(line.merchItem.id, -line.qty);
    }
  }
};

export const getSaleById = (id: string): Sale | null => {
  const bid = getActiveBranch().id;
  return recordedSales.find((s) => s.id === id && (!s.branchId || s.branchId === bid)) ?? null;
};

export const getFnbOrderById = (id: string): FnbOrder | null => {
  const bid = getActiveBranch().id;
  return recordedFnbOrders.find((o) => o.id === id && (!o.branchId || o.branchId === bid)) ?? null;
};

export const getMerchOrderById = (id: string): MerchOrder | null => {
  const bid = getActiveBranch().id;
  return recordedMerchOrders.find((o) => o.id === id && (!o.branchId || o.branchId === bid)) ?? null;
};

/**
 * Resolve a recorded transaction record by its kind — the single place that maps
 * a TxnKind back to its source ledger (ticket Sale / F&B / merch order). All three
 * carry a `refunds` array, so callers needing refund/total math can stay generic.
 */
export const getRecordByKind = (
  kind: TxnKind,
  id: string
): Sale | FnbOrder | MerchOrder | null => {
  if (kind === 'ticket') return getSaleById(id);
  if (kind === 'fnb') return getFnbOrderById(id);
  if (kind === 'merch') return getMerchOrderById(id);
  return null;
};

// --- Merch stock adjustments (stamped Admin corrections) ------------------
// Sale decrements / refund restores are NOT logged here — only deliberate Admin
// corrections (receiving stock, shrinkage, recounts). Front-end only.
const merchStockAdjustments: MerchStockAdjustment[] = [];

export const recordMerchStockAdjustment = (params: {
  merchItemId: string;
  delta: number;
  reason: string;
  adjustedBy: string;
  adjustedById: string;
}): MerchStockAdjustment => {
  const updated = adjustMerchStock(params.merchItemId, params.delta);
  const entry: MerchStockAdjustment = {
    id: `ma-${Math.random().toString(36).substring(2, 9)}`,
    branchId: getActiveBranch().id,
    merchItemId: params.merchItemId,
    delta: params.delta,
    newStock: updated?.stock ?? 0,
    reason: params.reason,
    adjustedBy: params.adjustedBy,
    adjustedById: params.adjustedById,
    adjustedAt: new Date().toISOString(),
  };
  merchStockAdjustments.unshift(entry);
  return entry;
};

/** Stamped stock-adjustment history for the active branch, newest first; optionally for one item. */
export const getMerchStockAdjustments = (
  merchItemId?: string
): MerchStockAdjustment[] => {
  const bid = getActiveBranch().id;
  const scoped = merchStockAdjustments.filter((a) => !a.branchId || a.branchId === bid);
  return merchItemId ? scoped.filter((a) => a.merchItemId === merchItemId) : scoped;
};

/** Merch items at/below their low-stock threshold or out of stock (Admin view). */
export const getLowStockMerchItems = (): MerchItem[] =>
  getMerchItems().filter(
    (m) => m.lowStockThreshold !== undefined && (m.stock ?? 0) <= m.lowStockThreshold
  );

// --- Unified inventory adjustments (stamped Admin corrections) -----------
// Sale decrements / refund restores are NOT logged here — only deliberate Admin
// corrections (receiving stock, shrinkage, recounts). Front-end only.
const restockLog: RestockLogEntry[] = [];

/**
 * Apply a stamped Admin stock adjustment to one inventory variant. Writes to
 * the catalog store (adjustInventoryStock) AND appends a RestockLogEntry.
 * Only call this from Admin; sale/refund paths call adjustInventoryStock directly.
 */
export const recordInventoryAdjustment = (params: {
  inventoryItemId: string;
  variantId: string;
  delta: number;
  reason: string;
  operator: string;
  operatorId: string;
  locationId?: string;
}): RestockLogEntry => {
  adjustInventoryStock(params.inventoryItemId, params.variantId, params.delta, params.locationId);
  const invItem = getInventoryItem(params.inventoryItemId);
  const variant = invItem?.variants.find((v) => v.id === params.variantId);
  const entry: RestockLogEntry = {
    id: `rsl-${Math.random().toString(36).substring(2, 9)}`,
    branchId: getActiveBranch().id,
    inventoryItemId: params.inventoryItemId,
    variantId: params.variantId,
    delta: params.delta,
    newStock: variant?.stock ?? 0,
    reason: params.reason,
    operator: params.operator,
    operatorId: params.operatorId,
    at: new Date().toISOString(),
    ...(params.locationId ? { locationId: params.locationId } : {}),
  };
  restockLog.unshift(entry);
  return entry;
};

// --- Stock transfer ledger (front-end only; stamped inter-location movements) ----
const stockTransferLog: StockTransfer[] = [];

export const addStockTransfer = (transfer: StockTransfer): void => {
  stockTransferLog.unshift(transfer);
};

export const getStockTransferLog = (
  inventoryItemId?: string,
  locationId?: string,
): StockTransfer[] => {
  const bid = getActiveBranch().id;
  return stockTransferLog
    .filter((t) => !t.branchId || t.branchId === bid)
    .filter((t) => !inventoryItemId || t.inventoryItemId === inventoryItemId)
    .filter((t) => !locationId || t.fromLocationId === locationId || t.toLocationId === locationId);
};

// --- Stock take log (front-end only; one record per counted variant per session) ---
// Seeded with a few past stock-take sessions so the Discrepancies report shows
// realistic history on first load. Every seed is stamped with a branchId so
// reports stay strictly branch-scoped (mostly hkt-central, the default branch).
// NOTE: seeds are ledger history only — they do NOT mutate live stock levels.
const stockTakeLog: StockTakeRecord[] = [
  // ── Session 2026-07-01 (yesterday, FOH count by Nok) ──
  {
    id: 'stk-seed-9', inventoryItemId: 'inv-m-slushie', variantId: 'green',
    locationId: STOCK_LOC_ROT, expectedQty: 3, countedQty: 2, discrepancy: -1,
    flagged: false, status: 'adjusted',
    countedBy: 'Nok (Reception)', countedById: 'op-2', countedAt: '2026-07-01T18:42:00.000Z',
    branchId: 'hkt-central',
  },
  {
    id: 'stk-seed-8', inventoryItemId: 'inv-mr-tshirt', variantId: INVENTORY_DEFAULT_VARIANT_ID,
    locationId: STOCK_LOC_ROT, expectedQty: 12, countedQty: 12, discrepancy: 0,
    flagged: false, status: 'confirmed',
    countedBy: 'Nok (Reception)', countedById: 'op-2', countedAt: '2026-07-01T18:38:00.000Z',
    branchId: 'hkt-central',
  },
  {
    id: 'stk-seed-7', inventoryItemId: 'inv-a-grip-socks', variantId: 'M',
    locationId: STOCK_LOC_ROT, expectedQty: 14, countedQty: 12, discrepancy: -2,
    flagged: false, status: 'adjusted',
    countedBy: 'Nok (Reception)', countedById: 'op-2', countedAt: '2026-07-01T18:35:00.000Z',
    branchId: 'hkt-central',
  },
  // ── Session 2026-06-24 (BOH count by Som) ──
  {
    id: 'stk-seed-6', inventoryItemId: 'inv-a-grip-socks', variantId: 'M',
    locationId: STOCK_LOC_BOH, expectedQty: 32, countedQty: 28, discrepancy: -4,
    flagged: true, status: 'adjusted',
    countedBy: 'Som (Reception)', countedById: 'op-1', countedAt: '2026-06-24T20:15:00.000Z',
    branchId: 'hkt-central',
  },
  {
    id: 'stk-seed-5', inventoryItemId: 'inv-m-water', variantId: INVENTORY_DEFAULT_VARIANT_ID,
    locationId: STOCK_LOC_BOH, expectedQty: 50, countedQty: 48, discrepancy: -2,
    flagged: false, status: 'adjusted',
    countedBy: 'Som (Reception)', countedById: 'op-1', countedAt: '2026-06-24T20:08:00.000Z',
    branchId: 'hkt-central',
  },
  {
    id: 'stk-seed-4', inventoryItemId: 'inv-mr-stickerpack', variantId: INVENTORY_DEFAULT_VARIANT_ID,
    locationId: STOCK_LOC_BOH, expectedQty: 57, countedQty: 60, discrepancy: 3,
    flagged: false, status: 'adjusted',
    countedBy: 'Som (Reception)', countedById: 'op-1', countedAt: '2026-06-24T20:02:00.000Z',
    branchId: 'hkt-central',
  },
  // ── Session 2026-06-17 (bulk store count by Som) ──
  {
    id: 'stk-seed-3', inventoryItemId: 'inv-a-socks', variantId: INVENTORY_DEFAULT_VARIANT_ID,
    locationId: STOCK_LOC_BULK, expectedQty: 85, countedQty: 80, discrepancy: -5,
    flagged: true, status: 'adjusted',
    countedBy: 'Som (Reception)', countedById: 'op-1', countedAt: '2026-06-17T19:44:00.000Z',
    branchId: 'hkt-central',
  },
  {
    id: 'stk-seed-2', inventoryItemId: 'inv-a-grip-socks', variantId: 'L',
    locationId: STOCK_LOC_BOH, expectedQty: 15, countedQty: 14, discrepancy: -1,
    flagged: false, status: 'adjusted',
    countedBy: 'Som (Reception)', countedById: 'op-1', countedAt: '2026-06-17T19:36:00.000Z',
    branchId: 'hkt-central',
  },
  {
    id: 'stk-seed-1', inventoryItemId: 'inv-mr-cap', variantId: INVENTORY_DEFAULT_VARIANT_ID,
    locationId: STOCK_LOC_BOH, expectedQty: 18, countedQty: 18, discrepancy: 0,
    flagged: false, status: 'confirmed',
    countedBy: 'Som (Reception)', countedById: 'op-1', countedAt: '2026-06-17T19:30:00.000Z',
    branchId: 'hkt-central',
  },
  // ── Session 2026-06-26 at the Chalong branch ──
  {
    id: 'stk-seed-c2', inventoryItemId: 'inv-a-socks', variantId: INVENTORY_DEFAULT_VARIANT_ID,
    locationId: STOCK_LOC_BOH, expectedQty: 62, countedQty: 59, discrepancy: -3,
    flagged: false, status: 'adjusted',
    countedBy: 'Nok (Reception)', countedById: 'op-2', countedAt: '2026-06-26T19:50:00.000Z',
    branchId: 'hkt-chalong',
  },
  {
    id: 'stk-seed-c1', inventoryItemId: 'inv-m-water', variantId: INVENTORY_DEFAULT_VARIANT_ID,
    locationId: STOCK_LOC_ROT, expectedQty: 14, countedQty: 14, discrepancy: 0,
    flagged: false, status: 'confirmed',
    countedBy: 'Nok (Reception)', countedById: 'op-2', countedAt: '2026-06-26T19:42:00.000Z',
    branchId: 'hkt-chalong',
  },
];

export const addStockTakeRecord = (record: StockTakeRecord): void => {
  stockTakeLog.unshift(record);
};

export const getStockTakeLog = (locationId?: string): StockTakeRecord[] => {
  const bid = getActiveBranch().id;
  return stockTakeLog
    .filter((r) => !r.branchId || r.branchId === bid)
    .filter((r) => !locationId || r.locationId === locationId);
};

/** Stamped restock-adjustment history for the active branch, newest first; optionally for one item. */
export const getRestockLog = (inventoryItemId?: string): RestockLogEntry[] => {
  const bid = getActiveBranch().id;
  const scoped = restockLog.filter((e) => !e.branchId || e.branchId === bid);
  return inventoryItemId ? scoped.filter((e) => e.inventoryItemId === inventoryItemId) : scoped;
};

// --- Purchase orders (reorder from external supplier) ---------------------
// Front-end only; stamped with operator + branch. Each PurchaseOrder groups
// one or more item/variant lines for a single supplier in a single batch.
// State machine: to_order → ordered → received (partial receipts leave state
// at 'ordered' with receivedQty incrementing until fully received).

// Seeded with a few past purchase orders so the Purchases report shows
// realistic history on first load. getPurchaseOrders filters strictly by
// branchId, so seeds are stamped per-branch (mostly hkt-central, the default).
// NOTE: seeds are ledger history only — they do NOT mutate live stock levels.
const purchaseOrders: PurchaseOrder[] = [
  // to_order: drafted, not yet placed
  {
    id: 'po-seed-3',
    branchId: 'hkt-central',
    supplierName: 'Bangkok Merch Co.',
    supplierContact: '02-555-0100',
    state: 'to_order',
    lines: [
      { id: 'po-seed-3-l1', inventoryItemId: 'inv-mr-tshirt', variantId: INVENTORY_DEFAULT_VARIANT_ID, itemName: 'Oto T-Shirt', variantLabel: '', orderedQty: 48, receivedQty: 0 },
      { id: 'po-seed-3-l2', inventoryItemId: 'inv-mr-cap', variantId: INVENTORY_DEFAULT_VARIANT_ID, itemName: 'Oto Cap', variantLabel: '', orderedQty: 24, receivedQty: 0 },
    ],
    createdAt: '2026-06-30T09:20:00.000Z',
    createdBy: 'Khun Lek (Manager)', createdById: 'op-3',
  },
  // ordered: placed with supplier, partially received
  {
    id: 'po-seed-2',
    branchId: 'hkt-central',
    supplierName: 'Island Beverages Co.',
    state: 'ordered',
    lines: [
      { id: 'po-seed-2-l1', inventoryItemId: 'inv-m-water', variantId: INVENTORY_DEFAULT_VARIANT_ID, itemName: 'Bottled Water', variantLabel: '', orderedQty: 120, receivedQty: 72 },
      { id: 'po-seed-2-l2', inventoryItemId: 'inv-m-slushie', variantId: 'red', itemName: 'Slushie', variantLabel: 'Red', orderedQty: 48, receivedQty: 48 },
    ],
    createdAt: '2026-06-27T10:05:00.000Z',
    createdBy: 'Khun Lek (Manager)', createdById: 'op-3',
    orderedAt: '2026-06-27T14:30:00.000Z',
    orderedBy: 'Khun Lek (Manager)', orderedById: 'op-3',
    expectedArrivalDate: '2026-07-03',
  },
  // received: fully delivered
  {
    id: 'po-seed-1',
    branchId: 'hkt-central',
    supplierName: 'Phuket Socks Ltd.',
    supplierContact: 'socks@pkt.th',
    state: 'received',
    lines: [
      { id: 'po-seed-1-l1', inventoryItemId: 'inv-a-grip-socks', variantId: 'S', itemName: 'Grip Socks', variantLabel: 'S', orderedQty: 24, receivedQty: 24 },
      { id: 'po-seed-1-l2', inventoryItemId: 'inv-a-grip-socks', variantId: 'M', itemName: 'Grip Socks', variantLabel: 'M', orderedQty: 24, receivedQty: 24 },
      { id: 'po-seed-1-l3', inventoryItemId: 'inv-a-grip-socks', variantId: 'L', itemName: 'Grip Socks', variantLabel: 'L', orderedQty: 24, receivedQty: 24 },
      { id: 'po-seed-1-l4', inventoryItemId: 'inv-mr-socks', variantId: INVENTORY_DEFAULT_VARIANT_ID, itemName: 'Grip Socks (Merch)', variantLabel: '', orderedQty: 120, receivedQty: 120 },
    ],
    createdAt: '2026-06-10T08:45:00.000Z',
    createdBy: 'Khun Lek (Manager)', createdById: 'op-3',
    orderedAt: '2026-06-11T09:00:00.000Z',
    orderedBy: 'Khun Lek (Manager)', orderedById: 'op-3',
    expectedArrivalDate: '2026-06-16',
    receivedAt: '2026-06-16T11:20:00.000Z',
    receivedBy: 'Som (Reception)', receivedById: 'op-1',
  },
  // one order for the second branch so its report isn't empty either
  {
    id: 'po-seed-4',
    branchId: 'hkt-chalong',
    supplierName: 'Phuket Socks Ltd.',
    supplierContact: 'socks@pkt.th',
    state: 'received',
    lines: [
      { id: 'po-seed-4-l1', inventoryItemId: 'inv-a-socks', variantId: INVENTORY_DEFAULT_VARIANT_ID, itemName: 'Regular Socks', variantLabel: '', orderedQty: 120, receivedQty: 120 },
    ],
    createdAt: '2026-06-18T09:10:00.000Z',
    createdBy: 'Khun Lek (Manager)', createdById: 'op-3',
    orderedAt: '2026-06-18T13:00:00.000Z',
    orderedBy: 'Khun Lek (Manager)', orderedById: 'op-3',
    expectedArrivalDate: '2026-06-23',
    receivedAt: '2026-06-23T10:40:00.000Z',
    receivedBy: 'Nok (Reception)', receivedById: 'op-2',
  },
];

/** All purchase orders for the active branch, newest first. */
export const getPurchaseOrders = (): PurchaseOrder[] => {
  const bid = getActiveBranch().id;
  return purchaseOrders.filter((o) => o.branchId === bid);
};

/**
 * Create a new purchase order (state = 'to_order') or add a line to an existing
 * 'to_order' order for the same supplier (within the same branch). Returns the
 * created/updated PurchaseOrder.
 *
 * If an open 'to_order' order already exists for that supplier+branch, the line
 * is appended to it (or its qty updated if the same item+variant already exists).
 */
export const addToPurchaseOrder = (params: {
  inventoryItemId: string;
  variantId: string;
  itemName: string;
  variantLabel: string;
  orderedQty: number;
  supplierName: string;
  supplierContact?: string;
  operator: string;
  operatorId: string;
}): PurchaseOrder => {
  const branchId = getActiveBranch().id;
  const now = new Date().toISOString();

  // Find an existing open order for this supplier+branch
  const existingIdx = purchaseOrders.findIndex(
    (o) => o.branchId === branchId && o.state === 'to_order' && o.supplierName === params.supplierName
  );

  if (existingIdx >= 0) {
    const existing = purchaseOrders[existingIdx];
    // Check if this item+variant already has a line
    const lineIdx = existing.lines.findIndex(
      (l) => l.inventoryItemId === params.inventoryItemId && l.variantId === params.variantId
    );
    if (lineIdx >= 0) {
      // Update qty
      const updatedLines = existing.lines.slice();
      updatedLines[lineIdx] = {
        ...existing.lines[lineIdx],
        orderedQty: existing.lines[lineIdx].orderedQty + params.orderedQty,
      };
      purchaseOrders[existingIdx] = { ...existing, lines: updatedLines };
    } else {
      // Append new line
      const newLine: PurchaseOrderLine = {
        id: `pol-${Math.random().toString(36).substring(2, 9)}`,
        inventoryItemId: params.inventoryItemId,
        variantId: params.variantId,
        itemName: params.itemName,
        variantLabel: params.variantLabel,
        orderedQty: params.orderedQty,
        receivedQty: 0,
      };
      purchaseOrders[existingIdx] = { ...existing, lines: [...existing.lines, newLine] };
    }
    return purchaseOrders[existingIdx];
  }

  // Create a new purchase order
  const newLine: PurchaseOrderLine = {
    id: `pol-${Math.random().toString(36).substring(2, 9)}`,
    inventoryItemId: params.inventoryItemId,
    variantId: params.variantId,
    itemName: params.itemName,
    variantLabel: params.variantLabel,
    orderedQty: params.orderedQty,
    receivedQty: 0,
  };
  const order: PurchaseOrder = {
    id: `po-${Math.random().toString(36).substring(2, 9)}`,
    branchId,
    supplierName: params.supplierName,
    ...(params.supplierContact ? { supplierContact: params.supplierContact } : {}),
    state: 'to_order',
    lines: [newLine],
    createdAt: now,
    createdBy: params.operator,
    createdById: params.operatorId,
  };
  purchaseOrders.unshift(order);
  return order;
};

/** Update line quantities on a 'to_order' purchase order (editable before placing). */
export const updatePurchaseOrderLine = (params: {
  orderId: string;
  lineId: string;
  orderedQty: number;
}): void => {
  const idx = purchaseOrders.findIndex((o) => o.id === params.orderId);
  if (idx < 0) return;
  const order = purchaseOrders[idx];
  if (order.state !== 'to_order') return;
  const lines = order.lines.map((l) =>
    l.id === params.lineId ? { ...l, orderedQty: Math.max(1, params.orderedQty) } : l
  );
  purchaseOrders[idx] = { ...order, lines };
};

/** Remove a line from a 'to_order' purchase order. Deletes the whole order if it has no lines left. */
export const removePurchaseOrderLine = (orderId: string, lineId: string): void => {
  const idx = purchaseOrders.findIndex((o) => o.id === orderId);
  if (idx < 0) return;
  const order = purchaseOrders[idx];
  if (order.state !== 'to_order') return;
  const lines = order.lines.filter((l) => l.id !== lineId);
  if (lines.length === 0) {
    purchaseOrders.splice(idx, 1);
  } else {
    purchaseOrders[idx] = { ...order, lines };
  }
};

/**
 * Mark a purchase order as placed with the supplier (state: to_order → ordered).
 * Sets the expected arrival date (today + leadTimeDays). Stamps operator + timestamp.
 */
export const markPurchaseOrderOrdered = (params: {
  orderId: string;
  expectedArrivalDate: string; // ISO date YYYY-MM-DD
  operator: string;
  operatorId: string;
  notes?: string;
}): void => {
  const idx = purchaseOrders.findIndex((o) => o.id === params.orderId);
  if (idx < 0) return;
  const order = purchaseOrders[idx];
  if (order.state !== 'to_order') return;
  purchaseOrders[idx] = {
    ...order,
    state: 'ordered',
    orderedAt: new Date().toISOString(),
    orderedBy: params.operator,
    orderedById: params.operatorId,
    expectedArrivalDate: params.expectedArrivalDate,
    ...(params.notes ? { notes: params.notes } : {}),
  };
};

/**
 * Receive stock for one line of a purchase order. Adds the received qty to the
 * line via recordInventoryAdjustment (which calls adjustInventoryStock with the
 * locationId, so stock is incremented exactly once). Closes the entire order if
 * all lines are fully received.
 *
 * Returns the updated PurchaseOrder.
 */
export const receivePurchaseOrderLine = (params: {
  orderId: string;
  lineId: string;
  receivedQty: number;
  locationId: string;
  operator: string;
  operatorId: string;
}): PurchaseOrder | null => {
  const idx = purchaseOrders.findIndex((o) => o.id === params.orderId);
  if (idx < 0) return null;
  const order = purchaseOrders[idx];
  if (order.state !== 'ordered') return null;
  const lineIdx = order.lines.findIndex((l) => l.id === params.lineId);
  if (lineIdx < 0) return null;

  const line = order.lines[lineIdx];
  // Clamp received qty to the remaining open quantity so over-receipt is impossible.
  const remaining = line.orderedQty - line.receivedQty;
  const clampedQty = Math.min(params.receivedQty, remaining);
  if (clampedQty <= 0) return order;
  const newReceivedQty = line.receivedQty + clampedQty;

  // recordInventoryAdjustment calls adjustInventoryStock internally (location-aware),
  // so this is the only stock mutation — no separate replenish call needed.
  recordInventoryAdjustment({
    inventoryItemId: line.inventoryItemId,
    variantId: line.variantId,
    delta: clampedQty,
    reason: `PO receipt: ${order.supplierName} (${order.id})`,
    operator: params.operator,
    operatorId: params.operatorId,
    locationId: params.locationId,
  });

  const updatedLines = order.lines.slice();
  updatedLines[lineIdx] = { ...line, receivedQty: newReceivedQty };

  // Close the whole order if all lines are fully received
  const allReceived = updatedLines.every((l) => l.receivedQty >= l.orderedQty);
  const now = new Date().toISOString();
  purchaseOrders[idx] = {
    ...order,
    lines: updatedLines,
    ...(allReceived
      ? { state: 'received' as PurchaseOrderState, receivedAt: now, receivedBy: params.operator, receivedById: params.operatorId }
      : {}),
  };

  return purchaseOrders[idx];
};

/**
 * Internal helper: maps a Sale/FnbOrder/MerchOrder record set to TxnSummary[]
 * with branchId + branchName resolved from the branch registry. Used by both
 * the branch-filtered public getter and the cross-branch member-profile getter.
 */
function _mapToTxnSummaries(
  sales: typeof recordedSales,
  fnbOrders: typeof recordedFnbOrders,
  merchOrders: typeof recordedMerchOrders,
  branchMap: Map<string, string>,
  defaultBranchName: string,
): TxnSummary[] {
  const resolveBranchName = (branchId?: string): string =>
    branchId ? (branchMap.get(branchId) ?? defaultBranchName) : defaultBranchName;

  const ticketTxns: TxnSummary[] = sales.map((s) => ({
    id: s.id,
    kind: 'ticket',
    reference: `#${s.id}`,
    createdAt: s.createdAt,
    total: s.total,
    status: s.status,
    operatorName: s.operatorName,
    customerLabel: s.customerNickname?.trim() || undefined,
    wristbandCode: s.wristbandCode,
    isDropOff: s.lines.some((l) => l.ticketType.id.startsWith('svc-')),
    bookingReference: s.bookingReference,
    branchId: s.branchId,
    branchName: resolveBranchName(s.branchId),
  }));
  const fnbTxns: TxnSummary[] = fnbOrders.map((o) => ({
    id: o.id,
    kind: 'fnb',
    reference: `#${o.id}`,
    createdAt: o.createdAt,
    total: o.total,
    status: o.status,
    operatorName: o.operatorName,
    customerLabel: o.wristband?.customerNickname ?? 'Guest',
    wristbandCode: o.wristband?.code,
    branchId: o.branchId,
    branchName: resolveBranchName(o.branchId),
  }));
  const merchTxns: TxnSummary[] = merchOrders.map((o) => ({
    id: o.id,
    kind: 'merch',
    reference: `#${o.id}`,
    createdAt: o.createdAt,
    total: o.total,
    status: o.status,
    operatorName: o.operatorName,
    customerLabel: o.wristband?.customerNickname ?? 'Guest',
    wristbandCode: o.wristband?.code,
    branchId: o.branchId,
    branchName: resolveBranchName(o.branchId),
  }));
  return [...ticketTxns, ...fnbTxns, ...merchTxns].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

/** Builds the branch name map and default name used by transaction mappers. */
function _buildBranchMap(): { branchMap: Map<string, string>; defaultBranchName: string } {
  const branches = getBranches();
  const branchMap = new Map(branches.map((b) => [b.id, b.name]));
  const defaultBranchName = branches[0]?.name ?? 'Unknown';
  return { branchMap, defaultBranchName };
}

/** Unified, newest-first list of every recorded ticket Sale and F&B order (active branch only). */
export const getTransactions = (): TxnSummary[] => {
  const bid = getActiveBranch().id;
  const { branchMap, defaultBranchName } = _buildBranchMap();
  return _mapToTxnSummaries(
    recordedSales.filter((s) => !s.branchId || s.branchId === bid),
    recordedFnbOrders.filter((o) => !o.branchId || o.branchId === bid),
    recordedMerchOrders.filter((o) => !o.branchId || o.branchId === bid),
    branchMap,
    defaultBranchName,
  );
};

/**
 * Cross-branch variant of getTransactions: returns ALL recorded transactions
 * regardless of active branch, each stamped with its originating branchId/branchName.
 * Used only by the member-profile path so the general history list stays branch-scoped.
 */
function _getAllTransactionsAcrossBranches(): TxnSummary[] {
  const { branchMap, defaultBranchName } = _buildBranchMap();
  return _mapToTxnSummaries(
    recordedSales,
    recordedFnbOrders,
    recordedMerchOrders,
    branchMap,
    defaultBranchName,
  );
}

/**
 * Cross-branch record lookup: finds a Sale/FnbOrder/MerchOrder by id across ALL
 * branches. Used for refund math in the member-profile path where a transaction
 * may have originated at a different branch than the current active one.
 */
function _getRecordByKindAcrossBranches(
  kind: TxnKind,
  id: string,
): Sale | FnbOrder | MerchOrder | null {
  if (kind === 'ticket') return recordedSales.find((s) => s.id === id) ?? null;
  if (kind === 'fnb') return recordedFnbOrders.find((o) => o.id === id) ?? null;
  if (kind === 'merch') return recordedMerchOrders.find((o) => o.id === id) ?? null;
  return null;
}

/**
 * Reporting seam (manager Reports module): raw, unfiltered access to every
 * recorded Sale/FnbOrder/MerchOrder across ALL branches. Reports do their own
 * date-range + branch filtering and re-derive tax through the engine
 * (lib/cartWire.ts, SCRUM-271) — this just
 * exposes the same in-memory ledgers `getTransactions()` already reads, without
 * the active-branch scoping. Read-only; never mutate the returned arrays.
 */
export const getAllSalesForReporting = (): Sale[] => [...recordedSales];
export const getAllFnbOrdersForReporting = (): FnbOrder[] => [...recordedFnbOrders];
export const getAllMerchOrdersForReporting = (): MerchOrder[] => [...recordedMerchOrders];

/**
 * Every camp/event (never party — parties have their own POS module and no
 * per-attendee entry fee) across every branch, for the manager Reports
 * "Event / camp revenue" view. Read-only snapshot of the same
 * mockCampsAndEvents array getEventsForDate/getEventById already read.
 */
export const getAllEventsForReporting = (): OtoEvent[] =>
  mockCampsAndEvents.filter((e) => e.type === 'camp' || e.type === 'event');

/**
 * Floor report (today's glance): a tiny per-day performance snapshot derived from
 * the in-memory transaction ledger for one date + branch. Amounts are net of
 * refunds and EXCLUDE F&B-credit settlement (surfaced separately as context),
 * so the four revenue buckets sum to the headline net revenue. This is a glance,
 * NOT an analytics dashboard (no AOV/trends/per-operator/customer-type splits).
 *
 * SEAM: in-memory only, so figures reset on reload. A real backend would query
 * the sales ledger for the date + branch. Dates are matched on the UTC date slice
 * to stay consistent with how parties/check-ins are seeded.
 */
export const getFloorReport = (date: string, branchId: string): FloorReport => {
  const onDate = (iso: string): boolean => iso.slice(0, 10) === date;
  const ticketHoursById = new Map(getTicketTypes().map((t) => [t.id, t.hours]));

  // --- Ticket + drop-off sales ------------------------------------------
  let ticketsTHB = 0;
  let dropoffTHB = 0;
  let kids = 0;
  let adults = 0;
  let ticketSaleCount = 0;
  const ticketMix = { oneHour: 0, twoHour: 0, fullDay: 0 };

  for (const s of recordedSales) {
    if (!onDate(s.createdAt)) continue;
    if (s.branchId && s.branchId !== branchId) continue;
    ticketSaleCount += 1;
    const refunded = s.refunds.reduce((a, r) => a + r.amountTHB, 0);
    const net = Math.max(0, s.total - refunded);
    // A drop-off / nanny check-in sale carries svc- service lines (see the
    // buildSale gotcha in replit.md); its whole sale lands in the Drop-off bucket.
    const isDropOff = s.lines.some((l) => l.ticketType.id.startsWith('svc-'));
    if (isDropOff) dropoffTHB += net;
    else ticketsTHB += net;
    // Guests = bracelets actually issued (a drop-off check-in issues the child's band too).
    kids += s.bracelets.children;
    adults += s.bracelets.adults;
    // Ticket mix by play duration — real park ticket lines only (skip svc- fees).
    for (const l of s.lines) {
      if (l.ticketType.id.startsWith('svc-')) continue;
      const hrs = ticketHoursById.get(l.ticketType.id) ?? 0;
      const people = l.kids + l.adults;
      if (hrs === 1) ticketMix.oneHour += people;
      else if (hrs === 2) ticketMix.twoHour += people;
      else if (hrs >= 3) ticketMix.fullDay += people;
    }
  }

  // --- F&B orders -------------------------------------------------------
  // Net sales = the non-credit take (cash + card + promptpay); F&B credit is
  // tracked separately. Refunds split into their credit-restored vs cash portions.
  let fnbTHB = 0;
  let creditPaidTHB = 0;
  let fnbOrderCount = 0;
  for (const o of recordedFnbOrders) {
    if (!onDate(o.createdAt)) continue;
    if (o.branchId && o.branchId !== branchId) continue;
    fnbOrderCount += 1;
    const nonCredit = o.payment.cash + o.payment.card + o.payment.promptpay;
    const creditRestored = o.refunds.reduce((a, r) => a + r.creditRestoredTHB, 0);
    const refundedCash = o.refunds.reduce((a, r) => a + (r.amountTHB - r.creditRestoredTHB), 0);
    fnbTHB += Math.max(0, nonCredit - refundedCash);
    creditPaidTHB += Math.max(0, o.payment.creditUsed - creditRestored);
  }

  // --- Merch / retail orders -------------------------------------------
  // Same net-of-credit treatment as F&B: cash + card + promptpay is the take,
  // F&B-credit settlement tracked separately, refunds split credit vs cash.
  let merchTHB = 0;
  let merchOrderCount = 0;
  for (const o of recordedMerchOrders) {
    if (!onDate(o.createdAt)) continue;
    if (o.branchId && o.branchId !== branchId) continue;
    merchOrderCount += 1;
    const nonCredit = o.payment.cash + o.payment.card + o.payment.promptpay;
    const creditRestored = o.refunds.reduce((a, r) => a + r.creditRestoredTHB, 0);
    const refundedCash = o.refunds.reduce((a, r) => a + (r.amountTHB - r.creditRestoredTHB), 0);
    merchTHB += Math.max(0, nonCredit - refundedCash);
    creditPaidTHB += Math.max(0, o.payment.creditUsed - creditRestored);
  }

  // --- Parties (date + branch) -----------------------------------------
  // Parties are scoped by branch (Events-owned); their POS-collected payments on
  // the day count toward revenue. Sales/F&B are single-branch in this prototype.
  const parties = getPartiesForDate(date, branchId);
  let partiesTHB = 0;
  let partyPaymentCount = 0;
  for (const p of parties) {
    for (const pay of p.partyPayments) {
      if (!onDate(pay.takenAt)) continue;
      partiesTHB += pay.amount;
      partyPaymentCount += 1;
    }
  }

  // Drop-off children physically in the park right now (LIVE — not date-bound).
  const dropOffInParkNow = getCheckIns().filter((c) => c.status === 'in_park').length;

  const revenueSplit: FloorReport['revenueSplit'] = [
    { key: 'tickets', label: 'Tickets', amountTHB: ticketsTHB },
    { key: 'fnb', label: 'F&B', amountTHB: fnbTHB },
    { key: 'merch', label: 'Merch', amountTHB: merchTHB },
    { key: 'parties', label: 'Parties', amountTHB: partiesTHB },
    { key: 'dropoff', label: 'Drop-off', amountTHB: dropoffTHB },
  ];

  return {
    date,
    branchId,
    netRevenueTHB: ticketsTHB + fnbTHB + merchTHB + partiesTHB + dropoffTHB,
    creditPaidTHB,
    txnCount: ticketSaleCount + fnbOrderCount + merchOrderCount + partyPaymentCount,
    guests: { kids, adults },
    revenueSplit,
    partiesToday: parties.length,
    dropOffInParkNow,
    ticketMix,
  };
};

/**
 * Live head-count for the persistent top-bar occupancy chip, driven by the
 * entrance gate. Adults scan in AND out; kids' bands don't operate the gate,
 * so the two populations are counted differently:
 *
 *  - ADULTS: gate-access bands whose latest gate event today is 'in'.
 *    Symmetric and reliable; re-entry just flips the derived state back.
 *  - REGULAR KIDS (issued under a sale/booking group with adult bands): a kid
 *    has no gate-out, so they count as inside while their group has ≥1 adult
 *    inside — recomputed on every read, so "the last adult gate-outs" departs
 *    the group's kids at that moment, and an adult re-entering brings them back.
 *  - DROP-OFF / NANNY KIDS: counted via their CheckIn status ('in_park'), and
 *    counted OUT by the drop-off check-out — never the group rule. Bands with
 *    a checkInId are excluded from the group rule so they can't double-count.
 *
 * Everything is derived (no counters to drift negative) and the gate-event
 * window is today-only, so nothing strands as "in" across days.
 */
export const getLiveOccupancy = (): LiveOccupancy => {
  // Adults inside = latest gate event today is 'in' (active branch).
  const adultsInside = getAdultsInsideNow();
  const adults = adultsInside.length;

  // Groups that currently have ≥1 adult inside.
  const groupsWithAdultInside = new Set<string>();
  for (const wb of adultsInside) {
    if (wb.groupId) groupsWithAdultInside.add(wb.groupId);
  }

  // Regular kids: kid bands linked to a group that still has an adult inside.
  // Drop-off/nanny bands (checkInId) are excluded — their exit is check-out.
  const regularKids = mockWristbands.filter(
    (w) => !w.gateAccess && !w.checkInId && !!w.groupId && groupsWithAdultInside.has(w.groupId),
  ).length;

  // Drop-off / nanny children physically in the park (branch-scoped getter).
  const dropOffKids = getCheckIns().filter((c) => c.status === 'in_park').length;

  const kids = regularKids + dropOffKids;
  return { adults, kids, total: adults + kids };
};

// --- End-of-day reconciliation ---------------------------------------------
// The branch's card/EDC terminals are now held in the editable catalog store
// (getEdcTerminals, re-exported above). Mirrors the Excel.

// Locked reconciliations, keyed by branch+date. In-memory only (resets on reload).
const closedEndOfDays: EndOfDay[] = [];

// SEAM: card sales in this prototype aren't stamped with the acquiring TID, so we
// deterministically fan card revenue across the branch's terminals by transaction
// id. In production each card txn records its real TID and this attribution goes away.
const pickTerminalTid = (txnId: string): string => {
  const terminals = getEdcTerminals();
  // The catalog store is editable, so the terminal list can in principle be
  // emptied. Guard the modulo so card attribution degrades to a clear sentinel
  // instead of crashing the End-of-Day reconciliation.
  if (terminals.length === 0) return 'NO-TERMINAL';
  let h = 0;
  for (let i = 0; i < txnId.length; i++) h = (h + txnId.charCodeAt(i)) % terminals.length;
  return terminals[h].tid;
};

/**
 * The start-of-day cash float for a date = the cash deliberately left in the drawer
 * when the most recent EARLIER day was closed (`floatLeftTHB`). When no prior close
 * exists (first day, or that close didn't record a float) it falls back to the branch
 * standard float. `fromDate` is the close it was carried from, or null for the default.
 */
export const getFloatCarryover = (
  date: string,
  branchId: string,
): { amountTHB: number; fromDate: string | null } => {
  const prior = closedEndOfDays
    .filter((e) => e.branchId === branchId && e.date < date && e.floatLeftTHB !== null)
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  return prior
    ? { amountTHB: prior.floatLeftTHB as number, fromDate: prior.date }
    : { amountTHB: DEFAULT_FLOAT_THB, fromDate: null };
};

/**
 * End-of-day reconciliation for a date + branch. If the day has been closed it's
 * returned locked (read-only) exactly as saved; otherwise a fresh OPEN record is
 * built with the EXPECTED side auto-filled from the in-memory ledger and the actual
 * side blank for staff to enter.
 *
 * Expected figures are derived per payment channel, net of refunds:
 *  - cash / promptpay / card(by TID): ticket + drop-off sales (by their tender) and
 *    the matching F&B tender (F&B refunds' non-credit portion split pro-rata).
 *  - party_prepay: POS-collected party payments (any method) — its own channel.
 *  - credit: F&B credit redeemed, net of F&B credit restored on refund.
 *  - ewallet / bank_transfer: no such tender in the mock, so expected 0 (staff can
 *    still record an actual, e.g. a manual transfer received).
 *
 * SEAM: in production expected figures come from persisted transactions; here
 * derived from in-memory mock data, so they reset on reload.
 */
export const getEndOfDay = (date: string, branchId: string): EndOfDay => {
  const saved = closedEndOfDays.find((e) => e.branchId === branchId && e.date === date);
  if (saved) return structuredClone(saved);

  const onDate = (iso: string): boolean => iso.slice(0, 10) === date;

  let cash = 0;
  let promptpay = 0;
  let creditPaid = 0;
  const cardByTid = new Map<string, number>(getEdcTerminals().map((t) => [t.tid, 0]));
  const addCard = (tid: string, amt: number) => cardByTid.set(tid, (cardByTid.get(tid) ?? 0) + amt);
  // Tenders from configurable 'other'-kind methods (e.g. a bank transfer) get
  // their own per-token channel so reporting never silently drops them.
  const otherByToken = new Map<string, number>();

  // Ticket + drop-off sales — single-tender, whole net to that tender. Route by
  // the method's KIND (normalised), so renamed/added methods still reconcile.
  for (const s of recordedSales) {
    if (!onDate(s.createdAt)) continue;
    if (!s.paymentMethod) continue;
    const refunded = s.refunds.reduce((a, r) => a + r.amountTHB, 0);
    const net = Math.max(0, s.total - refunded);
    if (net === 0) continue;
    const token = normalizePaymentMethod(s.paymentMethod);
    const kind = paymentMethodKind(token);
    if (kind === 'cash') cash += net;
    else if (kind === 'qr') promptpay += net;
    else if (kind === 'card') addCard(pickTerminalTid(s.id), net);
    else otherByToken.set(token, (otherByToken.get(token) ?? 0) + net);
  }

  // F&B orders — multi-tender; refunds reduce credit + non-credit separately, the
  // non-credit refund split pro-rata across the order's cash/card/promptpay take.
  for (const o of recordedFnbOrders) {
    if (!onDate(o.createdAt)) continue;
    const nonCredit = o.payment.cash + o.payment.card + o.payment.promptpay;
    const creditRestored = o.refunds.reduce((a, r) => a + r.creditRestoredTHB, 0);
    const refundedCash = o.refunds.reduce((a, r) => a + (r.amountTHB - r.creditRestoredTHB), 0);
    const keep = nonCredit > 0 ? Math.max(0, nonCredit - refundedCash) / nonCredit : 0;
    cash += o.payment.cash * keep;
    promptpay += o.payment.promptpay * keep;
    if (o.payment.card > 0) addCard(pickTerminalTid(o.id), o.payment.card * keep);
    creditPaid += Math.max(0, o.payment.creditUsed - creditRestored);
  }

  // Merch / retail orders — identical multi-tender treatment to F&B.
  for (const o of recordedMerchOrders) {
    if (!onDate(o.createdAt)) continue;
    const nonCredit = o.payment.cash + o.payment.card + o.payment.promptpay;
    const creditRestored = o.refunds.reduce((a, r) => a + r.creditRestoredTHB, 0);
    const refundedCash = o.refunds.reduce((a, r) => a + (r.amountTHB - r.creditRestoredTHB), 0);
    const keep = nonCredit > 0 ? Math.max(0, nonCredit - refundedCash) / nonCredit : 0;
    cash += o.payment.cash * keep;
    promptpay += o.payment.promptpay * keep;
    if (o.payment.card > 0) addCard(pickTerminalTid(o.id), o.payment.card * keep);
    creditPaid += Math.max(0, o.payment.creditUsed - creditRestored);
  }

  // Party prepayments — their own channel (don't fold into cash/card/promptpay).
  let partyPrepay = 0;
  for (const p of getPartiesForDate(date, branchId)) {
    for (const pay of p.partyPayments) {
      if (onDate(pay.takenAt)) partyPrepay += pay.amount;
    }
  }

  const lines: ReconLine[] = [
    { channel: 'cash', expectedTHB: Math.round(cash), actualTHB: null, differenceTHB: 0 },
    { channel: 'promptpay', expectedTHB: Math.round(promptpay), actualTHB: null, differenceTHB: 0 },
    ...getEdcTerminals().map((t) => ({
      channel: `card:${t.tid}`,
      expectedTHB: Math.round(cardByTid.get(t.tid) ?? 0),
      actualTHB: null,
      differenceTHB: 0,
    })),
    ...[...otherByToken.entries()].map(([token, amt]) => ({
      channel: `method:${token}`,
      expectedTHB: Math.round(amt),
      actualTHB: null,
      differenceTHB: 0,
    })),
    { channel: 'ewallet', expectedTHB: 0, actualTHB: null, differenceTHB: 0 },
    { channel: 'bank_transfer', expectedTHB: 0, actualTHB: null, differenceTHB: 0 },
    { channel: 'party_prepay', expectedTHB: Math.round(partyPrepay), actualTHB: null, differenceTHB: 0 },
    { channel: 'credit', expectedTHB: Math.round(creditPaid), actualTHB: null, differenceTHB: 0 },
  ];

  const base: EndOfDay = {
    id: `eod-${branchId.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${date}`,
    branchId,
    date,
    lines,
    // Start-of-day float carried over from the previous night's close (or default).
    cashCount: { countedTHB: null, floatTHB: getFloatCarryover(date, branchId).amountTHB, cashIncomeTHB: null },
    floatLeftTHB: DEFAULT_FLOAT_THB,
    vouchers: { handedOut: null, redeemed: null },
    totalExpectedTHB: 0,
    totalActualTHB: 0,
    totalDifferenceTHB: 0,
    status: 'open',
  };
  return recomputeEndOfDay(base);
};

/**
 * Lock a day's reconciliation. Any logged-in operator may close. Re-derives all
 * totals/differences (never trusts caller maths), stamps the operator + timestamp,
 * and stores it so the day reads back read-only. Returns null if already closed.
 */
export const closeEndOfDay = (working: EndOfDay, by: Operator): EndOfDay | null => {
  if (closedEndOfDays.some((e) => e.branchId === working.branchId && e.date === working.date)) {
    return null;
  }
  const finalized: EndOfDay = {
    ...recomputeEndOfDay(working),
    status: 'closed',
    closedBy: by.name,
    closedById: by.id,
    closedAt: new Date().toISOString(),
  };
  closedEndOfDays.push(finalized);
  return structuredClone(finalized);
};

/**
 * Scan-bracelet view: gather everything for one wristband code — the band (holder
 * + current F&B credit balance), the linked member if any, and every recorded
 * transaction for that code split out as its own order (newest first). The linked
 * member is resolved from a ticket Sale carrying this code that has a memberId.
 * `totalSpent` is net of refunds across these orders.
 */
export const getTransactionsByWristband = (code: string): WristbandActivity => {
  const needle = code.trim().toLowerCase();
  const wristband = getWristbandByCode(needle);
  const transactions = getTransactions().filter(
    (t) => (t.wristbandCode ?? '').toLowerCase() === needle,
  );

  // Resolve the linked member from a ticket sale on this band that names one.
  let member: Member | null = null;
  for (const t of transactions) {
    if (t.kind !== 'ticket') continue;
    const sale = getSaleById(t.id);
    if (sale?.memberId) {
      member = getMemberById(sale.memberId);
      if (member) break;
    }
  }

  const totalSpent = transactions.reduce((acc, t) => {
    const rec = getRecordByKind(t.kind, t.id);
    const refunded = rec?.refunds.reduce((a, r) => a + r.amountTHB, 0) ?? 0;
    return acc + Math.max(0, t.total - refunded);
  }, 0);

  return {
    wristband,
    member,
    transactions,
    totalSpent,
    orderCount: transactions.length,
  };
};

/**
 * Phone lookup view: gather everything for one member by phone number — the
 * member profile (null when no member matches), every wristband code linked to
 * them (via a ticket Sale carrying their memberId), and every recorded
 * transaction across those bands plus their own ticket sales (newest first).
 * `totalSpent` is net of refunds. F&B/drop-off on a member's band are included
 * even though those records don't carry the memberId directly.
 */
export const getTransactionsByMember = (phone: string): MemberActivity => {
  const member = getMemberByPhone(phone);
  if (!member) {
    return {
      member: null,
      phone: phone.trim(),
      bandCodes: [],
      transactions: [],
      totalSpent: 0,
      orderCount: 0,
      branchVisits: [],
    };
  }

  // Gather member's ticket sales and issued wristband codes across ALL branches
  // (member identity is global — not scoped to the active branch).
  const memberSaleIds = new Set<string>();
  const bandCodes = new Set<string>();
  recordedSales.forEach((s) => {
    if (s.memberId !== member.id) return;
    memberSaleIds.add(s.id);
    if (s.wristbandCode) bandCodes.add(s.wristbandCode.toLowerCase());
  });

  // Use the cross-branch getter so history aggregates across all branches.
  // The general transaction list stays branch-filtered; only this member-profile
  // path ignores the active-branch filter.
  const transactions = _getAllTransactionsAcrossBranches().filter((t) => {
    if (t.kind === 'ticket' && memberSaleIds.has(t.id)) return true;
    const code = (t.wristbandCode ?? '').toLowerCase();
    return code !== '' && bandCodes.has(code);
  });

  // Use cross-branch record lookup so refunds on other-branch records are
  // correctly subtracted even when a different branch is currently active.
  const totalSpent = transactions.reduce((acc, t) => {
    const rec = _getRecordByKindAcrossBranches(t.kind, t.id);
    const refunded = rec?.refunds.reduce((a, r) => a + r.amountTHB, 0) ?? 0;
    return acc + Math.max(0, t.total - refunded);
  }, 0);

  // Per-branch visit summary derived from the aggregated transactions.
  // A "visit" here counts each transaction (ticket, F&B, merch) as one entry.
  const visitCounts = new Map<string, { branchName: string; count: number }>();
  for (const t of transactions) {
    const bid = t.branchId ?? '';
    const bname = t.branchName ?? 'Unknown';
    const existing = visitCounts.get(bid);
    if (existing) {
      existing.count += 1;
    } else {
      visitCounts.set(bid, { branchName: bname, count: 1 });
    }
  }
  const branchVisits = [...visitCounts.entries()]
    .map(([branchId, { branchName, count }]) => ({ branchId, branchName, count }))
    .sort((a, b) => b.count - a.count);

  return {
    member,
    phone: member.phone,
    bandCodes: [...bandCodes],
    transactions,
    totalSpent,
    orderCount: transactions.length,
    branchVisits,
  };
};

/**
 * Mint (or find) a QR-keyed wallet for a walk-in fnb_credit grant at sale time.
 *
 * One wallet, one balance. The synthetic record (id: wb-walkin-<saleId>-<n>) carries
 * the full credit balance and is the ONLY digital record for this grant — no second
 * wristband is created at door check-in, since checkInFamilyWithPayment only creates
 * child food-provision bands, not adult bands. The printed QR voucher points directly
 * to this wallet; staff can also look it up by the generated synthetic band code.
 *
 * Idempotent: returns the existing qrCode if the wallet was already minted.
 */
export const ensureSaleGrantWallet = (
  saleId: string,
  grantIdx: number,
  amountTHB: number,
  by?: string,
  gateAccess: boolean = false,
): string => {
  const wbId = `wb-walkin-${saleId}-${grantIdx}`;
  const existing = mockWristbands.find((w) => w.id === wbId);
  if (existing) return existing.qrCode ?? `QR-${wbId}`;
  const qrCode = `QR-${wbId}`;
  const fresh: Wristband = {
    id: wbId,
    code: `WK-${saleId.slice(-4).toUpperCase()}-${grantIdx}`,
    customerNickname: 'Walk-in guest',
    creditBalanceTHB: amountTHB,
    qrCode,
    ledger: [{ kind: 'grant', amountTHB, source: 'ticket_sale', at: new Date().toISOString(), by }],
    // A credit wallet doubles as its owner's gate band. Gate access comes from
    // that person's ticket package (adults on a gate ticket → true; kids → false),
    // passed in by the caller — NOT a park-wide config.
    gateAccess,
    groupId: saleId,
  };
  mockWristbands.push(fresh);
  return qrCode;
};

/**
 * Mint the remaining digital band records for a walk-in ticket sale so the
 * entrance gate can resolve every band of the group. Called right after the
 * credit-wallet loop (ensureSaleGrantWallet) in Till.tsx / MobileTill.tsx:
 *  - adults beyond the already-minted credit wallets get a zero-balance
 *    gate-access band (`wb-gate-<saleId>-a<n>` — a DISTINCT id prefix from
 *    `wb-walkin-<saleId>-…` so printRouting's credit-voucher lookup is unaffected)
 *  - every NON-drop-off kid gets a no-gate-access band linked to the sale group
 *    (drop-off children are excluded — their band is minted at drop-off
 *    check-in with a checkInId and exits via check-out, never the group rule).
 * Idempotent per sale: re-invoking skips ids that already exist.
 */
export const issueWalkInBands = (sale: Sale): void => {
  const suffix = sale.id.slice(-4).toUpperCase();
  let aIdx = 0;
  let kIdx = 0;
  for (const p of buildPersonGrants(sale.lines)) {
    // Credit-earning persons already own a scannable wallet band minted by
    // ensureSaleGrantWallet (wb-walkin-…) — don't mint a second band for them.
    if (p.creditTHB > 0) continue;
    if (p.role === 'adult') {
      const id = `wb-gate-${sale.id}-a${aIdx}`;
      const code = `GT-${suffix}-A${aIdx}`;
      aIdx++;
      if (mockWristbands.some((w) => w.id === id)) continue;
      mockWristbands.push({
        id,
        code,
        customerNickname: 'Walk-in guest',
        creditBalanceTHB: 0,
        gateAccess: p.gateAccess, // from the adult's ticket package
        groupId: sale.id,
      });
    } else {
      const id = `wb-gate-${sale.id}-k${kIdx}`;
      const code = `GT-${suffix}-K${kIdx}`;
      kIdx++;
      if (mockWristbands.some((w) => w.id === id)) continue;
      mockWristbands.push({
        id,
        code,
        customerNickname: 'Walk-in child',
        creditBalanceTHB: 0,
        gateAccess: false, // kids never operate the gate
        groupId: sale.id,
      });
    }
  }
};

/**
 * Mint every wristband for a redeemed booking from the sale's ticket packages.
 * Credit-earning persons (adults and/or kids per the ticket's credit rule) get a
 * scannable wallet band `wb-bk-<saleId>-c<n>` (n = its index among fnb_credit
 * grants, so printRouting can pair vouchers to wallets by index); everyone else
 * gets a zero-balance band (`-a<n>` adults, `-k<n>` kids). Gate access comes purely
 * from each person's ticket. Returns the minted band codes (for the redeem toast).
 */
export const issueBookingBands = (sale: Sale, by?: string): string[] => {
  const suffix = sale.id.slice(-5).toUpperCase();
  const codes: string[] = [];
  let cIdx = 0;
  let aIdx = 0;
  let kIdx = 0;
  for (const p of buildPersonGrants(sale.lines)) {
    if (p.creditTHB > 0) {
      const wbId = `wb-bk-${sale.id}-c${cIdx}`;
      const code = `BK${suffix}C${cIdx}`;
      cIdx++;
      pushWristband({
        id: wbId,
        code,
        customerNickname: p.role === 'adult' ? 'Booking guest' : 'Booking child',
        creditBalanceTHB: p.creditTHB,
        gateAccess: p.gateAccess,
        groupId: sale.id,
      });
      // Seed the wallet ledger + assign the QR key so the voucher is scannable.
      initWalletLedger(wbId, p.creditTHB, 'ticket_sale', by);
      codes.push(code);
    } else if (p.role === 'adult') {
      const code = `BK${suffix}A${aIdx}`;
      pushWristband({
        id: `wb-bk-${sale.id}-a${aIdx}`,
        code,
        customerNickname: 'Booking guest',
        creditBalanceTHB: 0,
        gateAccess: p.gateAccess,
        groupId: sale.id,
      });
      aIdx++;
      codes.push(code);
    } else {
      const code = `BK${suffix}K${kIdx}`;
      pushWristband({
        id: `wb-bk-${sale.id}-k${kIdx}`,
        code,
        customerNickname: 'Booking child',
        creditBalanceTHB: 0,
        gateAccess: false,
        groupId: sale.id,
      });
      kIdx++;
      codes.push(code);
    }
  }
  return codes;
};

/**
 * Mock F&B credit restore: adds `amount` back to the in-memory wristband balance,
 * appends a `refund` ledger entry, and returns the new balance. Mirrors chargeFnbCredit.
 */
export const restoreFnbCredit = (wristbandId: string, amount: number, by?: string): number => {
  const wb = mockWristbands.find((w) => w.id === wristbandId);
  if (!wb) return 0;
  const restored = Math.max(0, amount);
  wb.creditBalanceTHB += restored;
  if (!wb.ledger) wb.ledger = [];
  wb.ledger.push({ kind: 'refund', amountTHB: restored, source: 'refund', at: new Date().toISOString(), by });
  return wb.creditBalanceTHB;
};

/**
 * Expire (zero out) the wristband's F&B credit, appending an `expire` ledger entry.
 * Only a negative amountTHB equal to the remaining balance is written. Returns the
 * new balance (always 0 after expiry).  Useful for EOD / shift-end clean-up flows.
 */
export const expireFnbCredit = (wristbandId: string, by?: string): number => {
  const wb = mockWristbands.find((w) => w.id === wristbandId);
  if (!wb || wb.creditBalanceTHB <= 0) return 0;
  const expired = wb.creditBalanceTHB;
  wb.creditBalanceTHB = 0;
  if (!wb.ledger) wb.ledger = [];
  wb.ledger.push({ kind: 'expire', amountTHB: -expired, source: 'expiry', at: new Date().toISOString(), by });
  return 0;
};

/**
 * Spend wallet credit at the MERCH station and return the new balance. Credit is
 * ONE universal pool (creditBalanceTHB) spendable at both stations; this seam is
 * kept separate from chargeFnbCredit only so the ledger records WHERE it was
 * spent ('merch_order' vs 'fnb_order'). Atomic single decrement, never below 0.
 */
export const chargeMerchCredit = (wristbandId: string, amount: number, by?: string): number => {
  const wb = mockWristbands.find((w) => w.id === wristbandId);
  if (!wb) return 0;
  const charge = Math.max(0, amount);
  wb.creditBalanceTHB = Math.max(0, wb.creditBalanceTHB - charge);
  if (!wb.ledger) wb.ledger = [];
  wb.ledger.push({ kind: 'spend', amountTHB: -charge, source: 'merch_order', at: new Date().toISOString(), by });
  return wb.creditBalanceTHB;
};

/**
 * Restore wallet credit refunded from a merch order. Returns to the SAME single
 * pool (creditBalanceTHB) and logs a 'refund' ledger entry. Mirrors restoreFnbCredit.
 */
export const restoreMerchCredit = (wristbandId: string, amount: number, by?: string): number => {
  const wb = mockWristbands.find((w) => w.id === wristbandId);
  if (!wb) return 0;
  const restored = Math.max(0, amount);
  wb.creditBalanceTHB = wb.creditBalanceTHB + restored;
  if (!wb.ledger) wb.ledger = [];
  wb.ledger.push({ kind: 'refund', amountTHB: restored, source: 'refund', at: new Date().toISOString(), by });
  return wb.creditBalanceTHB;
};

// --- Reprints (receipt / bracelet / credit grant) --------------------------
// Front-end only logs reprints against the recorded transaction. A real backend
// re-sends the print job to the receipt/bracelet printer.
export const recordReprint = (params: {
  transactionId: string;
  kind: TxnKind;
  items: string[];
  reprintedBy: string;
  reprintedById: string;
}): ReprintEvent => {
  const txn = getRecordByKind(params.kind, params.transactionId);

  const event: ReprintEvent = {
    id: `rp-${Math.random().toString(36).substring(2, 9)}`,
    transactionId: params.transactionId,
    kind: params.kind,
    items: params.items,
    reprintedBy: params.reprintedBy,
    reprintedById: params.reprintedById,
    reprintedAt: new Date().toISOString(),
  };

  if (txn) {
    if (!txn.reprints) txn.reprints = [];
    txn.reprints.push(event);
  }
  return event;
};

// --- Bracelet time-extensions (paid) --------------------------------------
// Add-time options, priced per bracelet. A real backend would source these from
// the venue's pricing config and reprogram the bracelets' valid-until time.
export interface ExtensionOption {
  id: string;
  label: string;
  minutes: number;
  pricePerBracelet: number;
}

export const getExtensionOptions = (): ExtensionOption[] => [
  { id: 'ext-30', label: '+30 minutes', minutes: 30, pricePerBracelet: 60 },
  { id: 'ext-60', label: '+1 hour', minutes: 60, pricePerBracelet: 100 },
  { id: 'ext-120', label: '+2 hours', minutes: 120, pricePerBracelet: 180 },
];

// Record a paid extension against a ticket booking (extends some or all of its bracelets).
// Payment is collected on the spot; front-end only logs it as an audit entry.
export const recordExtension = (params: {
  transactionId: string;
  label: string;
  minutesAdded: number;
  braceletCount: number;
  amountTHB: number;
  paymentMethod: string;
  extendedBy: string;
  extendedById: string;
}): Extension => {
  const sale = recordedSales.find((s) => s.id === params.transactionId);

  const extension: Extension = {
    id: `ex-${Math.random().toString(36).substring(2, 9)}`,
    transactionId: params.transactionId,
    label: params.label,
    minutesAdded: params.minutesAdded,
    braceletCount: params.braceletCount,
    amountTHB: params.amountTHB,
    paymentMethod: params.paymentMethod,
    extendedBy: params.extendedBy,
    extendedById: params.extendedById,
    extendedAt: new Date().toISOString(),
  };

  if (sale) {
    if (!sale.extensions) sale.extensions = [];
    sale.extensions.push(extension);
  }
  return extension;
};

/**
 * How many recorded transactions reference a payment method (by its token, or by
 * kind for the fixed F&B tender buckets). Admin uses this to warn before deleting
 * a method so reporting/history isn't silently orphaned. Front-end only.
 */
export const countTransactionsUsingPaymentMethod = (id: string): number => {
  const token = normalizePaymentMethod(id);
  const kind = getPaymentMethods().find((m) => m.id === token)?.kind;
  let count = 0;
  for (const s of recordedSales) {
    if (s.paymentMethod && normalizePaymentMethod(s.paymentMethod) === token) count++;
    for (const ex of s.extensions ?? []) {
      if (normalizePaymentMethod(ex.paymentMethod) === token) count++;
    }
  }
  // F&B orders hold fixed cash/card/promptpay buckets, matched to a method by kind.
  for (const o of recordedFnbOrders) {
    if (
      (kind === 'cash' && o.payment.cash > 0) ||
      (kind === 'card' && o.payment.card > 0) ||
      (kind === 'qr' && o.payment.promptpay > 0)
    ) {
      count++;
    }
  }
  for (const p of mockParties) {
    for (const pay of p.partyPayments) {
      if (normalizePaymentMethod(pay.method) === token) count++;
    }
  }
  return count;
};

const statusForRefunds = (total: number, refunds: Refund[]): TxnStatus => {
  const refunded = refunds.reduce((acc, r) => acc + r.amountTHB, 0);
  if (refunded <= 0) return 'paid';
  return refunded >= total ? 'refunded' : 'partially_refunded';
};

interface RecordRefundParams {
  transactionId: string;
  kind: TxnKind;
  scope: 'full' | 'partial';
  amountTHB: number;
  /** F&B only: F&B credit portion to push back to the wristband balance. */
  creditRestoredTHB: number;
  wristbandId?: string;
  reason: string;
  note?: string;
  refundedBy: string;
  refundedById: string;
  /**
   * Merch only: the order-line ids this refund covers. By-item refunds pass the
   * picked lines, whole-sale refunds pass every line, custom ฿ amounts pass none.
   * Used to return exactly those units to stock.
   */
  refundedLineIds?: string[];
}

/**
 * Record a refund against a recorded transaction, restore any F&B/merch credit,
 * and recompute the transaction status (paid -> partially_refunded -> refunded).
 *
 * In production refunds reverse the original payment and push to the HR Activity
 * Logbook, feeding a discounts+refunds report. Front-end only records them.
 * F&B credit reconciliation on ticket refunds (issued vs already-spent) is backend
 * logic — here ticket refunds never restore F&B credit.
 */
export const recordRefund = (
  params: RecordRefundParams
): { refund: Refund; newCreditBalance: number | null } => {
  const txn = getRecordByKind(params.kind, params.transactionId);

  // Clamp here too so the "never refund more than is left" invariant holds even
  // if a caller bypasses the UI guard. CreditGrant restore can't exceed the refund.
  let amountTHB = params.amountTHB;
  if (txn) {
    const alreadyRefunded = txn.refunds.reduce((acc, r) => acc + r.amountTHB, 0);
    amountTHB = Math.max(0, Math.min(amountTHB, txn.total - alreadyRefunded));
  }
  const creditRestoredTHB = Math.min(params.creditRestoredTHB, amountTHB);

  const refund: Refund = {
    id: `rf-${Math.random().toString(36).substring(2, 9)}`,
    transactionId: params.transactionId,
    kind: params.kind,
    scope: params.scope,
    amountTHB,
    creditRestoredTHB,
    reason: params.reason,
    note: params.note,
    refundedBy: params.refundedBy,
    refundedById: params.refundedById,
    refundedAt: new Date().toISOString(),
  };

  let newCreditBalance: number | null = null;
  if (creditRestoredTHB > 0 && params.wristbandId) {
    // Credit is one universal wallet pool, so the refund returns to the same
    // balance regardless of station. restoreMerchCredit/restoreFnbCredit hit the
    // SAME creditBalanceTHB — they differ only in the ledger source recorded.
    newCreditBalance =
      params.kind === 'merch'
        ? restoreMerchCredit(params.wristbandId, creditRestoredTHB, params.refundedBy ?? undefined)
        : restoreFnbCredit(params.wristbandId, creditRestoredTHB, params.refundedBy ?? undefined);
  }

  if (txn) {
    txn.refunds.push(refund);
    txn.status = statusForRefunds(txn.total, txn.refunds);
    if (params.kind === 'merch') {
      const merchTxn = txn as MerchOrder;
      // Which lines does THIS refund return to stock? Explicit by-item picks (or
      // a whole-sale refund's full line list) come through refundedLineIds; a
      // bare full-scope refund covers every line; a custom ฿ amount covers none.
      const covered =
        params.refundedLineIds && params.refundedLineIds.length > 0
          ? params.refundedLineIds
          : params.refundedLineIds === undefined && params.scope === 'full'
            ? merchTxn.lines.map((l) => l.id)
            : [];
      // Never re-restock a line an earlier refund already returned to stock.
      const alreadyRestocked = new Set(
        merchTxn.refunds.flatMap((r) => r.restockedLineIds ?? []),
      );
      const toRestock = covered.filter((id) => !alreadyRestocked.has(id));
      for (const id of toRestock) {
        const line = merchTxn.lines.find((l) => l.id === id);
        if (line) {
          if (line.merchItem.inventoryItemId) {
            adjustInventoryStock(
              line.merchItem.inventoryItemId,
              line.variantId ?? INVENTORY_DEFAULT_VARIANT_ID,
              line.qty,
            );
          } else {
            adjustMerchStock(line.merchItem.id, line.qty);
          }
        }
      }
      refund.restockedLineIds = toRestock;
    }

    // Ticket refunds: restore stocked add-on inventory on full-scope refunds.
    // Partial/custom-amount refunds don't return specific items, so no restock.
    if (params.kind === 'ticket' && params.scope === 'full') {
      const ticketTxn = txn as Sale;
      const addOnDefs = new Map(getAddOns().map((a) => [a.id, a]));
      const socksDef = addOnDefs.get('a-socks');
      // Guard: only restore if this is the first full refund (no prior full refund).
      const alreadyFullyRefunded = ticketTxn.refunds
        .slice(0, -1) // exclude the one we just pushed
        .some((r) => r.scope === 'full');
      if (!alreadyFullyRefunded) {
        for (const line of ticketTxn.lines) {
          if (line.socks > 0 && socksDef?.inventoryItemId) {
            adjustInventoryStock(
              socksDef.inventoryItemId,
              INVENTORY_DEFAULT_VARIANT_ID,
              line.socks,
            );
          }
          for (const sa of line.addOns) {
            const def = addOnDefs.get(sa.id);
            if (!def?.inventoryItemId) continue;
            if (sa.variantBreakdown && sa.variantBreakdown.length > 0) {
              for (const b of sa.variantBreakdown) {
                adjustInventoryStock(def.inventoryItemId, b.variantId, b.quantity);
              }
            } else {
              adjustInventoryStock(
                def.inventoryItemId,
                sa.variantId ?? INVENTORY_DEFAULT_VARIANT_ID,
                sa.quantity,
              );
            }
          }
        }
      }
    }

    // F&B refunds: restore stock-tracked menu items on full-scope refunds only
    // (partial/custom-amount refunds don't map back to specific units). Guard
    // against a second full refund double-restocking.
    if (params.kind === 'fnb' && params.scope === 'full') {
      const fnbTxn = txn as FnbOrder;
      const alreadyFullyRefunded = fnbTxn.refunds
        .slice(0, -1) // exclude the one we just pushed
        .some((r) => r.scope === 'full');
      if (!alreadyFullyRefunded) {
        for (const line of fnbTxn.lines) {
          const invId = line.menuItem.inventoryItemId;
          if (!invId) continue;
          adjustInventoryStock(invId, line.variantId ?? INVENTORY_DEFAULT_VARIANT_ID, line.qty);
        }
      }
    }
  }

  return { refund, newCreditBalance };
};

// --- Seeded historical transactions ---------------------------------------
// A handful of realistic past sales so the History screen isn't empty on load.
const wristbandById = (id: string): Wristband =>
  mockWristbands.find((w) => w.id === id)!;

const seedTicketLine = (
  ticketId: string,
  tier: CustomerTier,
  kids: number,
  adults: number,
  socks: number,
): CartLine => {
  const ticketType = getTicketTypes().find((t) => t.id === ticketId)!;
  const socksPrice = resolveRateToday(getAddOns().find((a) => a.id === 'a-socks')!.price);
  const ticketPrice = ticketType.prices[tier] ? resolveRateToday(ticketType.prices[tier]) : 0;
  const lineTotal = (kids + adults) * ticketPrice + socks * socksPrice;
  return {
    id: `seedline-${Math.random().toString(36).substring(2, 7)}`,
    ticketType,
    tier,
    kids,
    adults,
    socks,
    addOns: [],
    lineTotal,
  };
};

const seedFnbLine = (menuId: string, qty: number): FnbOrderLine => {
  const menuItem = getMenuItems().find((m) => m.id === menuId)!;
  return {
    id: `seedfnb-${Math.random().toString(36).substring(2, 7)}`,
    menuItem,
    qty,
    selectedModifiers: [],
    lineTotal: resolveRateToday(menuItem.price) * qty,
  };
};

function seedHistory(): void {
  // Ticket sales
  recordSale(
    buildSale({
      id: 'A4K2P9',
      createdAt: '2026-06-15T09:12:00.000Z',
      operatorId: 'op-1',
      operatorName: 'Som (Reception)',
      tier: 'thai',
      lines: [seedTicketLine('t-2h', 'thai', 2, 1, 2)],
      paymentMethod: 'cash',
      memberId: 'mem-1',
      customerNickname: 'Mali',
      customerPhone: '0811111111',
      wristbandCode: '1001',
    }),
  );
  recordSale(
    buildSale({
      id: 'B7M3X1',
      createdAt: '2026-06-15T10:40:00.000Z',
      operatorId: 'op-2',
      operatorName: 'Nok (Reception)',
      tier: 'tourist',
      lines: [seedTicketLine('t-fd', 'tourist', 1, 2, 0)],
      paymentMethod: 'card',
      customerNickname: 'Tom',
    }),
  );
  recordSale(
    buildSale({
      id: 'C2Q8R5',
      createdAt: '2026-06-14T15:05:00.000Z',
      operatorId: 'op-3',
      operatorName: 'Khun Lek (Manager)',
      tier: 'expat',
      lines: [seedTicketLine('t-pe', 'expat', 2, 2, 0)],
      paymentMethod: 'promptpay',
      memberId: 'mem-2',
      customerNickname: 'James',
      customerPhone: '0822222222',
    }),
  );

  // F&B orders
  // This one is already partially refunded (a damaged item returned to the tab).
  const fnbRefunded: FnbOrder = {
    id: '0042',
    operatorId: 'op-1',
    operatorName: 'Som (Reception)',
    wristband: wristbandById('wb-1'),
    lines: [seedFnbLine('m-nuggets', 1), seedFnbLine('m-fries', 2)],
    manualDiscounts: [],
    total: 300,
    pickupCode: '042',
    payment: { creditUsed: 300, cash: 0, card: 0, promptpay: 0 },
    createdAt: '2026-06-15T11:20:00.000Z',
    status: 'paid',
    refunds: [],
  };
  fnbRefunded.refunds.push({
    id: 'rf-seed-0042',
    transactionId: '0042',
    kind: 'fnb',
    scope: 'partial',
    amountTHB: 180,
    creditRestoredTHB: 180,
    reason: 'Damaged item',
    note: 'Fries spilled on the way to pickup.',
    refundedBy: 'Som (Reception)',
    refundedById: 'op-1',
    refundedAt: '2026-06-15T11:45:00.000Z',
  });
  fnbRefunded.status = statusForRefunds(fnbRefunded.total, fnbRefunded.refunds);
  recordFnbOrder(fnbRefunded);

  recordFnbOrder({
    id: '0043',
    operatorId: 'op-2',
    operatorName: 'Nok (Reception)',
    lines: [seedFnbLine('m-burger', 1), seedFnbLine('m-soda', 2)],
    manualDiscounts: [],
    total: 270,
    pickupCode: '043',
    payment: { creditUsed: 0, cash: 0, card: 270, promptpay: 0 },
    createdAt: '2026-06-15T12:05:00.000Z',
    status: 'paid',
    refunds: [],
  });
  recordFnbOrder({
    id: '0039',
    operatorId: 'op-3',
    operatorName: 'Khun Lek (Manager)',
    wristband: wristbandById('wb-2'),
    lines: [seedFnbLine('m-padthai', 2), seedFnbLine('m-juice', 1)],
    manualDiscounts: [],
    total: 370,
    pickupCode: '039',
    payment: { creditUsed: 350, cash: 20, card: 0, promptpay: 0 },
    createdAt: '2026-06-14T18:30:00.000Z',
    status: 'paid',
    refunds: [],
  });
  // A second F&B order on band 1001 (wb-1) so its scan-bracelet activity view
  // shows a ticket + two F&B orders + a drop-off — exercising every order type.
  recordFnbOrder({
    id: '0050',
    operatorId: 'op-1',
    operatorName: 'Som (Reception)',
    wristband: wristbandById('wb-1'),
    lines: [seedFnbLine('m-burger', 1), seedFnbLine('m-juice', 1)],
    manualDiscounts: [],
    total: 250,
    pickupCode: '050',
    payment: { creditUsed: 250, cash: 0, card: 0, promptpay: 0 },
    createdAt: '2026-06-15T14:10:00.000Z',
    status: 'paid',
    refunds: [],
  });
  // A drop-off / nanny service sale on band 1001 (svc- line, creditGrants: [] so no
  // spurious credit grant is minted — see the buildSale gotcha in replit.md).
  recordSale(
    buildSale({
      id: 'D9N4T7',
      createdAt: '2026-06-15T13:30:00.000Z',
      operatorId: 'op-1',
      operatorName: 'Som (Reception)',
      tier: 'thai',
      lines: [
        {
          id: 'seedline-dropoff-1001-ticket',
          ticketType: getTicketTypes().find((t) => t.id === 't-2h')!,
          tier: 'thai',
          kids: 1,
          adults: 0,
          socks: 0,
          addOns: [],
          lineTotal: 300,
        },
        {
          id: 'seedline-dropoff-1001-service',
          ticketType: {
            id: 'svc-dropoff',
            name: 'Drop-off service',
            durationLabel: 'One-time',
            hours: 2,
            prices: { tourist: wwp(150), expat: wwp(150), thai: wwp(150) },
          },
          tier: 'thai',
          kids: 0,
          adults: 0,
          socks: 0,
          addOns: [],
          lineTotal: 150,
        },
      ],
      creditGrants: [],
      paymentMethod: 'promptpay',
      customerNickname: 'Mama Som',
      wristbandCode: '1001',
    }),
  );
}

seedHistory();

// --- Parties (read-only bookings from Events + POS-owned transactions) -----
// PartyBooking core fields are READ-ONLY, sourced from the Events module (single
// source of truth). The POS only creates partyExtraCharges and partyPayments
// against a party. In production these sync back to the party record / billing.
// Module-memory only — extra charges / payments are wiped on reload.
/** @deprecated Use getActiveBranch() from BranchContext / catalogStore instead. */
export const getCurrentBranch = (): string => getActiveBranch().id;

// Today's date (yyyy-mm-dd) so seeded parties always land on "today".
const todayISO = (): string => new Date().toISOString().slice(0, 10);

const mockParties: PartyBooking[] = [
  {
    id: 'party-1',
    branchId: 'hkt-central',
    status: 'upcoming',
    title: "Sophia's 5th Birthday Party",
    attendees: [
      {
        id: 'att-p1-1',
        name: 'Lily Sukprasert',
        age: 5,
        language: 'Thai',
        allergyFlag: false,
        dietaryFlag: false,
        parentName: 'Khun Fon Sukprasert',
        parentPhone: '+66 81 100 1001',
        emergencyContact: 'Khun Toey Sukprasert — +66 81 100 1002',
        rsvpStatus: 'attending',
        parentAttending: true,
      },
      {
        id: 'att-p1-2',
        name: 'Max Rivers',
        age: 5,
        language: 'English',
        allergyFlag: true,
        allergyDetail: 'Tree nut allergy — no nuts of any kind',
        dietaryFlag: false,
        parentName: 'Claire Rivers',
        parentPhone: '+66 92 200 2001',
        emergencyContact: 'Tom Rivers — +66 92 200 2002',
        rsvpStatus: 'attending',
        parentAttending: true,
      },
      {
        id: 'att-p1-3',
        name: 'Nong Bua Chaiyo',
        age: 4,
        language: 'Thai',
        allergyFlag: false,
        dietaryFlag: true,
        dietaryDetail: 'No pork',
        parentName: 'Khun Malee Chaiyo',
        parentPhone: '+66 88 300 3001',
        emergencyContact: 'Khun Pong Chaiyo — +66 88 300 3002',
        rsvpStatus: 'maybe',
        parentAttending: false,
      },
      {
        id: 'att-p1-4',
        name: 'Isabella Park',
        age: 6,
        language: 'Korean / English',
        allergyFlag: false,
        dietaryFlag: false,
        parentName: 'Ji-Yeon Park',
        parentPhone: '+66 96 400 4001',
        emergencyContact: 'Min Park — +66 96 400 4002',
        rsvpStatus: 'declined',
        parentAttending: false,
      },
    ],
    childName: 'Sophia',
    kidAge: 5,
    parentName: 'Khun Ploy',
    whatsapp: '+66 81 234 5678',
    date: todayISO(),
    startTime: '13:00',
    endTime: '15:30',
    location: 'Party Room A',
    expectedKids: 12,
    expectedAdults: 18,
    decoration: 'Unicorn theme — pastel balloons, banner & table runner',
    activities: 'Face painting (13:30) + magic show (14:15)',
    finalMessage: 'Parent wants the cake brought out right after the magic show.',
    partyHost: 'Bee',
    entertainmentHost: 'Magic Mike',
    packageName: 'Deluxe Party Package (up to 12 kids)',
    basePrice: 12000,
    lineItems: [
      { id: 'pli-1', name: 'Extra child (over 12)', qty: 0, price: 450 },
      { id: 'pli-2', name: 'Face painting add-on', qty: 1, price: 1500 },
      { id: 'pli-3', name: 'Goodie bags', qty: 12, price: 120 },
    ],
    deposit: 5000,
    depositDate: '2026-06-01',
    posNotes: 'Balance due on the day. Parent will settle at reception.',
    kitchen: {
      needed: true,
      kidsMenu: ['Chicken nuggets', 'French fries', 'Mini pizzas'],
      adultsMenu: ['Pad Thai', 'Green curry', 'Spring rolls'],
      setMenu: true,
      foodItems: [
        { id: 'pf-1', name: 'Kids set menu', qty: 12 },
        { id: 'pf-2', name: 'Adult set menu', qty: 18 },
        { id: 'pf-3', name: 'Fruit platter', qty: 3 },
      ],
      cake: { type: 'our', qty: 1, time: '14:45', note: 'Unicorn cake, "Happy 5th Sophia"' },
      serviceTime: '13:45',
    },
    bar: {
      serviceTime: '13:15',
      items: [
        { id: 'pb-1', name: 'Soft drinks (jug)', qty: 6 },
        { id: 'pb-2', name: 'Coffee / tea station', qty: 1 },
      ],
    },
    timeline: [
      { time: '13:00', label: 'Guests arrive · wristbands issued', auto: true },
      { time: '13:15', label: 'Bar / drinks station opens' },
      { time: '13:30', label: 'Face painting starts' },
      { time: '13:45', label: 'Food service' },
      { time: '14:15', label: 'Magic show' },
      { time: '14:45', label: 'Cake cutting' },
      { time: '15:30', label: 'Party ends · goodie bags', auto: true },
    ],
    rsvp: { attending: 10, maybe: 2, declined: 3, totalKids: 12, totalAdults: 18 },
    partyExtraCharges: [],
    partyPayments: [],
  },
  {
    id: 'party-2',
    branchId: 'hkt-central',
    status: 'in_progress',
    title: "Leo's 7th Birthday Bash",
    childName: 'Leo',
    kidAge: 7,
    parentName: 'Khun Aof',
    whatsapp: '+66 89 876 5432',
    date: todayISO(),
    startTime: '11:00',
    endTime: '13:00',
    location: 'Party Room B',
    expectedKids: 8,
    expectedAdults: 10,
    decoration: 'Superhero theme',
    activities: 'Obstacle course challenge',
    partyHost: 'Gus',
    packageName: 'Standard Party Package (up to 8 kids)',
    basePrice: 8000,
    lineItems: [{ id: 'pli-4', name: 'Piñata', qty: 1, price: 800 }],
    deposit: 3000,
    depositDate: '2026-06-05',
    kitchen: {
      needed: true,
      kidsMenu: ['Hot dogs', 'French fries'],
      adultsMenu: ['Margherita pizza'],
      setMenu: false,
      foodItems: [
        { id: 'pf-4', name: 'Kids hot dog combo', qty: 8 },
        { id: 'pf-5', name: 'Large pizza', qty: 3 },
      ],
      cake: { type: 'own', note: 'Parent brings their own cake — store in kitchen fridge.' },
      serviceTime: '11:45',
    },
    timeline: [
      { time: '11:00', label: 'Guests arrive · wristbands issued', auto: true },
      { time: '11:30', label: 'Obstacle course' },
      { time: '11:45', label: 'Food service' },
      { time: '12:30', label: 'Cake cutting' },
      { time: '13:00', label: 'Party ends', auto: true },
    ],
    rsvp: { attending: 8, maybe: 0, declined: 1, totalKids: 8, totalAdults: 10 },
    partyExtraCharges: [],
    partyPayments: [],
  },
  {
    id: 'party-3',
    branchId: 'hkt-central',
    status: 'upcoming',
    title: "Mia & Mark's Twin Party",
    childName: 'Mia & Mark',
    kidAge: 4,
    parentName: 'Khun Nan',
    whatsapp: '+66 92 111 2222',
    date: todayISO(),
    startTime: '16:00',
    endTime: '18:00',
    location: 'Party Room A',
    expectedKids: 16,
    expectedAdults: 20,
    decoration: 'Jungle / safari theme',
    activities: 'Balloon animals + storytime',
    partyHost: 'Bee',
    entertainmentHost: 'Storyteller Joy',
    packageName: 'Deluxe Party Package (up to 12 kids)',
    basePrice: 12000,
    lineItems: [
      { id: 'pli-5', name: 'Extra child (over 12)', qty: 4, price: 450 },
      { id: 'pli-6', name: 'Balloon animal artist', qty: 1, price: 2000 },
    ],
    deposit: 6000,
    depositDate: '2026-06-08',
    posNotes: 'Twin celebration — two cakes requested.',
    kitchen: {
      needed: true,
      kidsMenu: ['Mini burgers', 'Veggie sticks', 'Fruit cups'],
      adultsMenu: ['Fried rice', 'Chicken satay'],
      setMenu: true,
      foodItems: [
        { id: 'pf-6', name: 'Kids set menu', qty: 16 },
        { id: 'pf-7', name: 'Adult set menu', qty: 20 },
      ],
      cake: { type: 'our', qty: 2, time: '17:15', note: 'Two safari cakes — one each for Mia & Mark' },
      serviceTime: '16:45',
    },
    bar: { serviceTime: '16:15', items: [{ id: 'pb-3', name: 'Soft drinks (jug)', qty: 8 }] },
    timeline: [
      { time: '16:00', label: 'Guests arrive · wristbands issued', auto: true },
      { time: '16:30', label: 'Balloon animals' },
      { time: '16:45', label: 'Food service' },
      { time: '17:15', label: 'Cake cutting (x2)' },
      { time: '17:30', label: 'Storytime' },
      { time: '18:00', label: 'Party ends', auto: true },
    ],
    rsvp: { attending: 14, maybe: 2, declined: 4, totalKids: 16, totalAdults: 20 },
    partyExtraCharges: [],
    partyPayments: [],
  },
];

/** Parties for a given date + branch, sorted by start time. */
export const getPartiesForDate = (date: string, branchId: string): PartyBooking[] =>
  mockParties
    .filter((p) => p.date === date && p.branchId === branchId)
    .sort((a, b) => a.startTime.localeCompare(b.startTime));

export const getPartyById = (id: string): PartyBooking | null =>
  mockParties.find((p) => p.id === id) ?? null;

// --- Camps & one-off events (type: 'camp' | 'event') -----------------------
// These are created and registered in the Events module — the POS reads them
// read-only. No billing actions exist for camp/event types.
const mockCampsAndEvents: OtoEvent[] = [
  {
    id: 'camp-1',
    branchId: 'hkt-central',
    type: 'camp' as EventType,
    status: 'upcoming',
    title: 'Oto Summer Camp 2026 — Week 1',
    date: todayISO(),
    startTime: '09:00',
    endTime: '17:00',
    location: 'Main Hall + Outdoor Area',
    expectedKids: 18,
    expectedAdults: 4,
    entryPriceTHB: wwp(600),
    dateRange: {
      start: todayISO(),
      end: (() => {
        const d = new Date(todayISO() + 'T00:00:00');
        d.setDate(d.getDate() + 4);
        return d.toISOString().slice(0, 10);
      })(),
    },
    attendees: [
      {
        id: 'att-c1-1',
        name: 'Emma Wattanasin',
        age: 7,
        language: 'Thai / English',
        allergyFlag: true,
        allergyDetail: 'Peanut allergy — carry EpiPen (kept at front desk)',
        dietaryFlag: false,
        parentAttending: false,
        attendanceDays: (() => {
          const days: string[] = [];
          for (let i = 0; i < 5; i++) {
            const d = new Date(todayISO() + 'T00:00:00');
            d.setDate(d.getDate() + i);
            days.push(d.toISOString().slice(0, 10));
          }
          return days;
        })(),
        parentName: 'Khun Pim Wattanasin',
        parentPhone: '+66 81 111 2233',
        emergencyContact: 'Khun Noi Wattanasin — +66 81 111 4455',
      },
      {
        id: 'att-c1-2',
        name: 'Lucas Bernard',
        age: 8,
        language: 'French / English',
        allergyFlag: false,
        dietaryFlag: true,
        dietaryDetail: 'Vegetarian — no meat or fish',
        parentAttending: true,
        attendanceDays: (() => {
          const days: string[] = [];
          for (let i = 0; i < 5; i++) {
            const d = new Date(todayISO() + 'T00:00:00');
            d.setDate(d.getDate() + i);
            days.push(d.toISOString().slice(0, 10));
          }
          return days;
        })(),
        parentName: 'Marie Bernard',
        parentPhone: '+66 89 234 5566',
        emergencyContact: 'Pierre Bernard — +66 89 234 7788',
      },
      {
        id: 'att-c1-3',
        name: 'Mia Tanaka',
        age: 6,
        language: 'Japanese / Thai',
        allergyFlag: false,
        dietaryFlag: false,
        attendanceDays: (() => {
          const days: string[] = [];
          for (let i = 1; i < 4; i++) {
            const d = new Date(todayISO() + 'T00:00:00');
            d.setDate(d.getDate() + i);
            days.push(d.toISOString().slice(0, 10));
          }
          return days;
        })(),
        parentName: 'Yuki Tanaka',
        parentPhone: '+66 82 345 6677',
        emergencyContact: 'Kenji Tanaka — +66 82 345 8899',
      },
      {
        id: 'att-c1-4',
        name: 'Noah Prasert',
        age: 9,
        language: 'Thai / English',
        allergyFlag: true,
        allergyDetail: 'Lactose intolerant — avoid all dairy products',
        dietaryFlag: false,
        attendanceDays: (() => {
          const days: string[] = [];
          for (let i = 0; i < 5; i++) {
            const d = new Date(todayISO() + 'T00:00:00');
            d.setDate(d.getDate() + i);
            days.push(d.toISOString().slice(0, 10));
          }
          return days;
        })(),
        parentName: 'Khun Daeng Prasert',
        parentPhone: '+66 85 456 7788',
        emergencyContact: 'Khun Wan Prasert — +66 85 456 9900',
      },
      {
        id: 'att-c1-5',
        name: 'Lily Chen',
        age: 7,
        language: 'Chinese / English',
        allergyFlag: false,
        dietaryFlag: true,
        dietaryDetail: 'Halal only',
        attendanceDays: (() => {
          const days: string[] = [];
          for (let i = 0; i < 3; i++) {
            const d = new Date(todayISO() + 'T00:00:00');
            d.setDate(d.getDate() + i);
            days.push(d.toISOString().slice(0, 10));
          }
          return days;
        })(),
        parentName: 'Mei Chen',
        parentPhone: '+66 86 567 8899',
        emergencyContact: 'Wei Chen — +66 86 567 0011',
      },
    ],
  },
  {
    id: 'event-1',
    branchId: 'hkt-central',
    type: 'event' as EventType,
    status: 'upcoming',
    title: "Kids' Art & Craft Workshop",
    date: todayISO(),
    startTime: '14:00',
    endTime: '16:00',
    location: 'Art Studio',
    expectedKids: 10,
    expectedAdults: 5,
    entryPriceTHB: wwp(350),
    attendees: [
      {
        id: 'att-e1-1',
        name: 'Anya Somsak',
        age: 5,
        language: 'Thai',
        allergyFlag: false,
        dietaryFlag: false,
        parentName: 'Khun Joy Somsak',
        parentPhone: '+66 91 111 0001',
        emergencyContact: 'Khun Arm Somsak — +66 91 111 0002',
      },
      {
        id: 'att-e1-2',
        name: 'Oliver Smith',
        age: 6,
        language: 'English',
        allergyFlag: true,
        allergyDetail: 'Bee sting allergy — parent carries EpiPen',
        dietaryFlag: false,
        parentName: 'Sarah Smith',
        parentPhone: '+66 92 222 0001',
        emergencyContact: 'John Smith — +66 92 222 0002',
      },
      {
        id: 'att-e1-3',
        name: 'Siri Nakamura',
        age: 7,
        language: 'Thai / Japanese',
        allergyFlag: false,
        dietaryFlag: true,
        dietaryDetail: 'No shellfish',
        parentName: 'Yoko Nakamura',
        parentPhone: '+66 93 333 0001',
        emergencyContact: 'Hiro Nakamura — +66 93 333 0002',
      },
    ],
  },
];

// --- Unified Events API (all types) ----------------------------------------

/** All events (party + camp + one-off) for a given date + branch, sorted by start time. */
export const getEventsForDate = (
  date: string,
  branchId: string,
  typeFilter?: EventType | 'all',
): OtoEvent[] => {
  const parties: OtoEvent[] = mockParties
    .filter((p) => p.date === date && p.branchId === branchId)
    .map((p) => ({ ...p, type: 'party' as EventType }));

  const others = mockCampsAndEvents.filter(
    (e) => e.date === date && e.branchId === branchId,
  );

  const all = [...parties, ...others].sort((a, b) =>
    a.startTime.localeCompare(b.startTime),
  );

  if (!typeFilter || typeFilter === 'all') return all;
  return all.filter((e) => e.type === typeFilter);
};

/**
 * Active event passes for the till's sell side: a running camp session for the
 * date (date within the camp's range) plus today's / upcoming walk-up events.
 * Birthday parties are excluded — they have no flat entry price (their guests
 * ride the party tab). Sorted by date, then start time. ISO date strings sort
 * lexicographically, so plain string compares are correct here.
 */
export const getActiveEventPasses = (date: string, branchId: string): OtoEvent[] => {
  return mockCampsAndEvents
    .filter((e) => e.branchId === branchId && e.type !== 'party')
    .filter((e) => {
      if (e.type === 'camp') {
        const start = e.dateRange?.start ?? e.date;
        const end = e.dateRange?.end ?? e.date;
        return date >= start && date <= end;
      }
      // Walk-up event: today or upcoming.
      return e.date >= date;
    })
    .sort((a, b) =>
      a.date === b.date ? a.startTime.localeCompare(b.startTime) : a.date.localeCompare(b.date),
    );
};

/** Fetch a single event by id, across all types. */
export const getEventById = (id: string): OtoEvent | null => {
  const party = mockParties.find((p) => p.id === id);
  if (party) return { ...party, type: 'party' as EventType };
  return mockCampsAndEvents.find((e) => e.id === id) ?? null;
};

// Counter for event-issued wristband codes (range 3000+, separate from walk-in bands).
let _eventWristbandSeq = 3000;
const nextEventBandCode = (): string => String(++_eventWristbandSeq);

/**
 * Helper: find a mutable EventAttendee in either mockCampsAndEvents or mockParties.
 * Returns a reference to the actual in-memory object so callers can mutate it.
 */
function findMutableAttendee(
  eventId: string,
  attendeeId: string,
): EventAttendee | null {
  const campEvent = mockCampsAndEvents.find((e) => e.id === eventId);
  if (campEvent) {
    return campEvent.attendees?.find((a) => a.id === attendeeId) ?? null;
  }
  const party = mockParties.find((p) => p.id === eventId);
  if (party) {
    return party.attendees?.find((a) => a.id === attendeeId) ?? null;
  }
  return null;
}

// The attendee fields the till captures for a walk-up add (id / attendanceDays /
// check-in state are derived by the mutator, not supplied by the caller).
export interface NewEventAttendeeInput {
  name: string;
  age?: number;
  dateOfBirth?: string;
  language?: string;
  allergyFlag?: boolean;
  allergyDetail?: string;
  dietaryFlag?: boolean;
  dietaryDetail?: string;
  notes?: string;
  parentName: string;
  parentPhone?: string;
  emergencyContact?: string;
  parentAttending?: boolean;
}

// Every ISO date in [start, end] inclusive — a camp's full attendance range.
function campRangeDays(start: string, end: string): string[] {
  const days: string[] = [];
  const d = new Date(start + 'T00:00:00');
  const last = new Date(end + 'T00:00:00');
  while (d <= last) {
    days.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }
  return days;
}

/**
 * POS action: add a walk-up attendee to a camp / event / party at the door.
 *
 * The Events module remains the source of truth for registrations; the till only
 * contributes one. Two modes:
 *   - registerProperly=false (quick-add): camps scope the attendee to TODAY only
 *     (attendanceDays = [today]) so they appear for this session but not future
 *     days.
 *   - registerProperly=true: camps get the full date-range attendanceDays so the
 *     attendee persists for every remaining camp day.
 * Events / parties are single-day, so attendanceDays is left undefined for them.
 *
 * Pushes onto the matching event's attendees[] (camp/event in mockCampsAndEvents,
 * party in mockParties). The `notes` field is stamped with the operator so the
 * roster shows who added the walk-up. In-memory only. Returns the new attendee
 * (or null if the event is not found).
 */
export const addEventAttendee = (
  eventId: string,
  input: NewEventAttendeeInput,
  opts: { registerProperly: boolean; today: string },
  stamp: { operatorName: string; operatorId: string },
): EventAttendee | null => {
  const campEvent = mockCampsAndEvents.find((e) => e.id === eventId);
  const party = campEvent ? undefined : mockParties.find((p) => p.id === eventId);
  if (!campEvent && !party) return null;

  const isCamp = campEvent?.type === 'camp';
  let attendanceDays: string[] | undefined;
  if (isCamp) {
    attendanceDays =
      opts.registerProperly && campEvent?.dateRange
        ? campRangeDays(campEvent.dateRange.start, campEvent.dateRange.end)
        : [opts.today];
  }

  const stampNote = `Walk-up added by ${stamp.operatorName}${
    opts.registerProperly ? ' (registered for full range)' : ' (today only)'
  }`;
  const attendee: EventAttendee = {
    id: `att-walkup-${Math.random().toString(36).substring(2, 9)}`,
    name: input.name,
    age: input.age,
    dateOfBirth: input.dateOfBirth,
    language: input.language,
    allergyFlag: input.allergyFlag,
    allergyDetail: input.allergyDetail,
    dietaryFlag: input.dietaryFlag,
    dietaryDetail: input.dietaryDetail,
    notes: input.notes ? `${input.notes} — ${stampNote}` : stampNote,
    attendanceDays,
    parentName: input.parentName,
    parentPhone: input.parentPhone,
    emergencyContact: input.emergencyContact,
    parentAttending: input.parentAttending,
  };

  const host = campEvent ?? party!;
  host.attendees = [...(host.attendees ?? []), attendee];
  return attendee;
};

export interface EventCheckinResult {
  attendee: EventAttendee;
  date: string;
  wristbandCode: string;
  parentWristbandCode?: string;
}

/**
 * Check an event attendee in for a specific date (use today for events/parties;
 * camps key by the current attendance date so each session is independent).
 * Mints a kid wristband (always) and a parent wristband (when parentAttending).
 * Pushes both bands into the global wristband store so F&B scanning works.
 * Returns null if already checked in for this date or attendee not found.
 */
export const checkInEventAttendee = (
  eventId: string,
  attendeeId: string,
  date: string,
  operator: { operatorName: string; operatorId: string },
): EventCheckinResult | null => {
  const att = findMutableAttendee(eventId, attendeeId);
  if (!att) return null;
  if (att.checkinByDate?.[date]?.checkedInAt) return null; // already checked in

  const kidCode = nextEventBandCode();
  const parentCode = att.parentAttending ? nextEventBandCode() : undefined;

  const record: EventAttendeeCheckin = {
    checkedInAt: new Date().toISOString(),
    wristbandCode: kidCode,
    parentWristbandCode: parentCode,
    operatorName: operator.operatorName,
    operatorId: operator.operatorId,
  };

  att.checkinByDate = { ...(att.checkinByDate ?? {}), [date]: record };

  // Push kid band into the global wristband store (allergy scanning).
  // Kid band never operates the gate; when a parent attends, both bands share
  // an attendee-scoped group so the kid follows the group occupancy rule.
  const eventGroupId = parentCode ? `evt-grp-${eventId}-${attendeeId}` : undefined;
  mockWristbands.push({
    id: `evt-wb-${kidCode}`,
    code: kidCode,
    customerNickname: att.name,
    creditBalanceTHB: 0,
    holderName: att.name,
    allergiesMedical: att.allergyFlag ? att.allergyDetail : undefined,
    foodRestrictions: att.dietaryFlag ? att.dietaryDetail : undefined,
    mayOrderFood: false, // event attendees don't order F&B on wristband credit
    gateAccess: false,
    groupId: eventGroupId,
  });

  // Push parent band if applicable.
  if (parentCode) {
    mockWristbands.push({
      id: `evt-wb-${parentCode}`,
      code: parentCode,
      customerNickname: `${att.name} (parent)`,
      creditBalanceTHB: 0,
      holderName: att.parentName,
      mayOrderFood: false,
      gateAccess: true,
      groupId: eventGroupId,
    });
  }

  return { attendee: att, date, wristbandCode: kidCode, parentWristbandCode: parentCode };
};

/**
 * Check an event attendee out for a specific date. No-op if not checked in.
 * Returns the updated attendee or null if not found.
 */
export const checkOutEventAttendee = (
  eventId: string,
  attendeeId: string,
  date: string,
  _operator: { operatorName: string; operatorId: string },
): EventAttendee | null => {
  const att = findMutableAttendee(eventId, attendeeId);
  if (!att) return null;
  const record = att.checkinByDate?.[date];
  if (!record?.checkedInAt || record.checkedOutAt) return null; // not in or already out

  record.checkedOutAt = new Date().toISOString();
  // Stamp checkout operator (update the existing record).
  att.checkinByDate = {
    ...(att.checkinByDate ?? {}),
    [date]: { ...record, checkedOutAt: record.checkedOutAt },
  };

  return att;
};

/**
 * POS action: edit a party's booking fields in-place (the till may now edit a
 * party, not just bill against it). Applies the patch, stamps it with the
 * operator + timestamp, and keeps the protected fields fixed — `id`/`branch`
 * never change here, and the POS-owned ledgers (`partyExtraCharges` /
 * `partyPayments`) are only touched by their own mutators. In-memory only.
 */
export const updateParty = (
  partyId: string,
  patch: Partial<
    Omit<PartyBooking, 'id' | 'branchId' | 'partyExtraCharges' | 'partyPayments'>
  >,
  stamp: { editedBy: string; editedById: string },
): PartyBooking | null => {
  const idx = mockParties.findIndex((p) => p.id === partyId);
  if (idx < 0) return null;
  const current = mockParties[idx];
  const updated: PartyBooking = {
    ...current,
    ...patch,
    // Protected identity + POS-owned ledgers always win over any patch.
    id: current.id,
    branchId: current.branchId,
    partyExtraCharges: current.partyExtraCharges,
    partyPayments: current.partyPayments,
    // Audit stamp.
    lastEditedBy: stamp.editedBy,
    lastEditedById: stamp.editedById,
    lastEditedAt: new Date().toISOString(),
  };
  mockParties[idx] = updated;
  return updated;
};

/**
 * POS action: charge extra F&B or play tickets to a party tab (`kind`). Appends a
 * PartyExtraCharge stamped with the operator. Raises the party's computed total /
 * outstanding. In-memory only.
 */
export const addPartyExtraCharge = (
  partyId: string,
  params: {
    kind: 'fnb' | 'ticket';
    items: { name: string; qty: number; lineTotal: number }[];
    total: number;
    chargedBy: string;
    chargedById: string;
  },
): PartyExtraCharge | null => {
  const party = mockParties.find((p) => p.id === partyId);
  if (!party) return null;
  // Enforce the invariant in the mutator (not just the UI): a charge is the sum
  // of its line totals and can never be negative.
  const total = Math.max(0, params.total);
  const charge: PartyExtraCharge = {
    id: `pec-${Math.random().toString(36).substring(2, 9)}`,
    kind: params.kind,
    items: params.items,
    total,
    chargedBy: params.chargedBy,
    chargedById: params.chargedById,
    chargedAt: new Date().toISOString(),
  };
  party.partyExtraCharges.push(charge);
  return charge;
};

/**
 * POS action: take a payment against a party's outstanding balance. Appends a
 * PartyPayment stamped with the operator. Lowers the outstanding. In-memory only.
 */
export const addPartyPayment = (
  partyId: string,
  params: {
    amount: number;
    method: PartyPaymentMethod;
    takenBy: string;
    takenById: string;
  },
): PartyPayment | null => {
  const party = mockParties.find((p) => p.id === partyId);
  if (!party) return null;
  // Clamp here too (like recordRefund) so the "never collect more than is owed"
  // invariant holds even if a caller bypasses the UI guard.
  const amount = Math.min(Math.floor(params.amount), computePartyOutstanding(party));
  if (amount <= 0) return null;
  const payment: PartyPayment = {
    id: `ppy-${Math.random().toString(36).substring(2, 9)}`,
    amount,
    method: params.method,
    takenBy: params.takenBy,
    takenById: params.takenById,
    takenAt: new Date().toISOString(),
  };
  party.partyPayments.push(payment);
  return payment;
};

// --- Station devices --------------------------------------------------------
// The physical hardware available across the branch is now held in the editable
// catalog store (getAvailableDevices, re-exported above). Each iPad's
// StationProfile references these by id; reached via the local print agent.

// --- Drop-Off check-in ------------------------------------------------------
// CheckIns are created by the public Drop-Off web form; available nannies come
// from HR scheduling (who's on shift). Mocked here.
const mockNannies: Nanny[] = [
  { id: 'nanny-1', name: 'Pim', available: true },
  { id: 'nanny-2', name: 'Jum', available: true },
  { id: 'nanny-3', name: 'Bow', available: true },
  { id: 'nanny-4', name: 'Aor', available: false },
];

// A nanny annotated with her live load. The strict 1:1 ratio is relaxed: one
// nanny may cover several active children (especially siblings), so `available`
// now just means on shift. `load` is how many active children she already covers
// and `coveredNames` lists them (for "Nok — 2 kids" pickers + the soft reminder).
export interface NannyAvailability {
  id: string;
  name: string;
  onShift: boolean;
  load: number;
  coveredNames: string[];
  /** Back-compat convenience: the first covered child's name, if any. */
  busyWith?: string;
  /** On shift (pickable). No longer gated by current load. */
  available: boolean;
}

/**
 * Full nanny roster with each nanny's live load. A nanny counts a child while
 * assigned to any active one (status `registered` with a nanny, or `in_park`);
 * checking that child out frees the slot. `forCheckInId` excludes the child being
 * edited so her own current nanny isn't counted against herself. Being on shift is
 * all that's required to pick her — she may already be covering other children.
 */
export const getNannyRoster = (forCheckInId?: string): NannyAvailability[] => {
  const bid = getActiveBranch().id;
  return mockNannies.map((n) => {
    const coveredNames = mockCheckIns
      .filter(
        (c) =>
          c.branchId === bid &&
          c.assignedNannyId === n.id &&
          c.status !== 'out' &&
          c.id !== forCheckInId,
      )
      .map((c) => c.childName);
    return {
      id: n.id,
      name: n.name,
      onShift: n.available,
      load: coveredNames.length,
      coveredNames,
      busyWith: coveredNames[0],
      available: n.available,
    };
  });
};

/** Nannies on shift (each may cover several children — the 1:1 ratio is relaxed). */
export const getAvailableNannies = (): Nanny[] =>
  getNannyRoster()
    .filter((r) => r.available)
    .map((r) => ({ id: r.id, name: r.name, available: true }));

/**
 * Check whether a nanny will be available at the requested start time.
 * Returns true when at least one on-shift nanny can take another child at
 * that time, false when all are already at capacity.
 *
 * Mocked here: a fixed set of times are marked as fully booked to make the
 * UX real (customer must pick a different slot). The specific nanny is
 * ALWAYS assigned by staff at check-in — this call is capacity/availability
 * only.
 *
 * BACKEND NOTE: real availability must be computed server-side from HR
 * scheduling (who is rostered for that shift) PLUS live nanny assignments
 * and occupancy at the requested time. The online form must call an
 * authenticated endpoint that re-checks availability at payment time to
 * prevent double-booking between concurrent web sessions. Replace this
 * getter with a fetch() to that endpoint at the swap seam.
 */
export const checkNannyAvailability = (
  startTime: string,
  _durationHours: number,
): boolean => {
  // Times when all on-shift nannies are at capacity in the mock.
  // Customers selecting these times are told to pick another slot.
  const BUSY_TIMES = new Set(['10:00', '11:30', '14:00', '16:30']);
  return !BUSY_TIMES.has(startTime);
};

// Minutes-ago helper so seeded timestamps stay relative to "now".
const minutesAgoISO = (mins: number): string =>
  new Date(Date.now() - mins * 60_000).toISOString();

// Later-today helper (ISO) for the Schedule tab.
const laterTodayISO = (hour: number, minute: number): string => {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
};

// Schedule relative to "now" so seeded online-booked arrivals always read as
// upcoming ("Scheduled"), never "Overdue", whatever time the demo is run.
const minutesFromNowISO = (mins: number): string =>
  new Date(Date.now() + mins * 60_000).toISOString();

const mockCheckIns: CheckIn[] = [
  // reg-1: a TWO-child registration (siblings on one parent web form) so the
  // multi-child "Check in & pay" flow is testable. Both share parent + phone.
  {
    id: 'ci-1',
    registrationId: 'reg-1',
    childName: 'Nong Mali',
    childAge: 4,
    parentName: 'Khun Ratana',
    contactMethod: 'whatsapp',
    // Matches seeded member "Mali" (thai-verified for TH) so Check in & pay
    // auto-applies the thai member rate across the whole family.
    phone: '+66811111111',
    allergiesMedical: 'Peanut allergy — EpiPen in the backpack',
    mayOrderFood: true,
    foodRestrictions: 'No nuts, no shellfish',
    confirmationsAccepted: true,
    serviceType: 'nanny',
    nannyStartTime: '10:00',
    status: 'registered',
    // Booked online (paid) — surfaces in the Schedule tab for payment-free check-in.
    scheduledFor: laterTodayISO(10, 0),
    bookedDurationMinutes: 120,
    registeredAt: minutesAgoISO(25),
    // Seeded WA connection state: amber "awaiting confirmation"
    waConnection: { status: 'pending', sentAt: minutesAgoISO(25) },
  },
  {
    id: 'ci-9',
    registrationId: 'reg-1', // Mali's sibling, same web-form submission
    childName: 'Nong Ton',
    childAge: 7,
    parentName: 'Khun Ratana',
    contactMethod: 'whatsapp',
    phone: '+66811111111',
    mayOrderFood: true,
    confirmationsAccepted: true,
    serviceType: 'drop_off',
    status: 'registered',
    // Booked online (paid) — same family as Nong Mali; Schedule tab.
    scheduledFor: laterTodayISO(10, 0),
    bookedDurationMinutes: 120,
    registeredAt: minutesAgoISO(25),
    waConnection: { status: 'pending', sentAt: minutesAgoISO(25) },
  },
  {
    id: 'ci-2',
    registrationId: 'reg-2',
    childName: 'Tyler',
    childAge: 6,
    parentName: 'Mr. Johnson',
    contactMethod: 'whatsapp',
    phone: '+66922224444',
    mayOrderFood: false,
    confirmationsAccepted: true,
    serviceType: 'drop_off',
    status: 'registered',
    // Booked online (paid) — Schedule tab, payment-free check-in.
    scheduledFor: laterTodayISO(11, 30),
    bookedDurationMinutes: 90,
    registeredAt: minutesAgoISO(12),
    // Seeded WA connection state: red "no connection — update needed"
    waConnection: { status: 'failed', sentAt: minutesAgoISO(12) },
  },
  {
    id: 'ci-3',
    registrationId: 'reg-3',
    childName: 'Nong Beam',
    childAge: 5,
    parentName: 'Khun Suda',
    contactMethod: 'telegram',
    phone: '+66811112222',
    mayOrderFood: true,
    foodRestrictions: 'Vegetarian',
    confirmationsAccepted: true,
    serviceType: 'drop_off',
    status: 'registered',
    // Booked online (paid) — Schedule tab, payment-free check-in.
    scheduledFor: laterTodayISO(18, 0),
    bookedDurationMinutes: 120,
    registeredAt: minutesAgoISO(6),
    // Telegram contact — no WhatsApp connection check
  },
  {
    id: 'ci-4',
    registrationId: 'reg-4',
    childName: 'Emma',
    childAge: 7,
    parentName: 'Mrs. Carter',
    contactMethod: 'whatsapp',
    phone: '+66933335555',
    mayOrderFood: true,
    confirmationsAccepted: true,
    serviceType: 'nanny',
    assignedNannyId: 'nanny-1',
    assignedNannyName: 'Pim',
    status: 'in_park',
    registeredAt: minutesAgoISO(70),
    checkedInAt: minutesAgoISO(40),
    bookedDurationMinutes: 50, // ~10 min left → due soon
    assignedBy: 'Som (Reception)',
    checkedInBy: 'Som (Reception)',
    // Seeded WA connection state: green "WhatsApp confirmed"
    waConnection: { status: 'confirmed', sentAt: minutesAgoISO(70), confirmedAt: minutesAgoISO(68) },
    changeLog: [
      {
        id: 'cl-seed-1',
        field: 'Booked play time',
        oldValue: '60 min',
        newValue: '50 min',
        changedBy: 'Som (Reception)',
        changedById: 'op-2',
        changedAt: minutesAgoISO(45),
      },
    ],
  },
  {
    id: 'ci-5',
    registrationId: 'reg-5',
    childName: 'Nong Ploy',
    childAge: 3,
    parentName: 'Khun Wirat',
    contactMethod: 'whatsapp',
    phone: '+66844446666',
    allergiesMedical: 'Mild lactose intolerance',
    mayOrderFood: true,
    foodRestrictions: 'No dairy',
    confirmationsAccepted: true,
    serviceType: 'nanny',
    status: 'registered',
    scheduledFor: laterTodayISO(16, 30),
    registeredAt: minutesAgoISO(180),
    // Seeded WA connection state: amber "awaiting confirmation" (scheduled child)
    waConnection: { status: 'pending', sentAt: minutesAgoISO(180) },
  },
  {
    id: 'ci-6',
    registrationId: 'reg-6',
    childName: 'Lucas',
    childAge: 8,
    parentName: 'Mr. Silva',
    contactMethod: 'whatsapp',
    phone: '+66955557777',
    mayOrderFood: false,
    confirmationsAccepted: true,
    serviceType: 'drop_off',
    status: 'out',
    registeredAt: minutesAgoISO(200),
    checkedInAt: minutesAgoISO(180),
    checkedOutAt: minutesAgoISO(20),
    checkedInBy: 'Nok (Reception)',
    checkedOutBy: 'Nok (Reception)',
    checkedOutById: 'op-3',
    waConnection: { status: 'confirmed', sentAt: minutesAgoISO(200), confirmedAt: minutesAgoISO(197) },
  },
  {
    id: 'ci-7',
    registrationId: 'reg-7',
    childName: 'Kai',
    childAge: 6,
    parentName: 'Mr. Tanaka',
    contactMethod: 'whatsapp',
    phone: '+66966668888',
    mayOrderFood: true,
    confirmationsAccepted: true,
    serviceType: 'drop_off',
    status: 'in_park',
    registeredAt: minutesAgoISO(110),
    checkedInAt: minutesAgoISO(95),
    bookedDurationMinutes: 60, // ~35 min over → overdue
    checkedInBy: 'Nok (Reception)',
    // Prepaid items: nuggets (redeemed) + juice (not yet redeemed). Juice is ฿70 unused at pickup.
    foodProvision: {
      mode: 'prepaid_items',
      paidTHB: 190,
      items: [
        { menuItemId: 'm-nuggets', menuItemName: 'Chicken Nuggets', unitPriceTHB: 120, qty: 1, redeemedQty: 1 },
        { menuItemId: 'm-juice', menuItemName: 'Fresh Orange Juice', unitPriceTHB: 70, qty: 1, redeemedQty: 0 },
      ],
    },
    waConnection: { status: 'confirmed', sentAt: minutesAgoISO(110), confirmedAt: minutesAgoISO(107) },
  },
  {
    id: 'ci-8',
    registrationId: 'reg-8',
    childName: 'Mia',
    childAge: 5,
    parentName: 'Khun Ananya',
    contactMethod: 'telegram',
    phone: '+66977779999',
    allergiesMedical: 'Asthma — inhaler in bag',
    mayOrderFood: true,
    foodRestrictions: 'No fizzy drinks',
    confirmationsAccepted: true,
    serviceType: 'drop_off',
    status: 'in_park',
    registeredAt: minutesAgoISO(60),
    checkedInAt: minutesAgoISO(52),
    bookedDurationMinutes: 60, // ~8 min left → due soon
    checkedInBy: 'Som (Reception)',
    // Prepaid credit: ฿150 loaded, ฿80 spent at F&B → ฿70 remaining at pickup.
    foodProvision: {
      mode: 'prepaid_credit',
      creditAmountTHB: 150,
      paidTHB: 150,
    },
    // Telegram contact — no WhatsApp connection check
  },
  // Seeded check-in records for the demo bookings that have drop-off children.
  // ci-bk1 ↔ OTO-DEMO-MIX (one adult + this drop-off child)
  {
    id: 'ci-bk1',
    registrationId: 'reg-bk-mix',
    childName: 'Nong Saai',
    childAge: 4,
    parentName: 'Khun Dao',
    contactMethod: 'whatsapp',
    phone: '0899999901',
    mayOrderFood: false,
    confirmationsAccepted: true,
    serviceType: 'drop_off',
    status: 'registered',
    // Pre-paid demo booking (OTO-DEMO-MIX) — Schedule tab, payment-free check-in.
    scheduledFor: laterTodayISO(13, 0),
    bookedDurationMinutes: 60,
    registeredAt: '2026-06-27T08:30:00.000Z',
  },
  // ci-bk2 ↔ OTO-DEMO-DOP (drop-off only booking)
  {
    id: 'ci-bk2',
    registrationId: 'reg-bk-dop',
    childName: 'Nong Pim',
    childAge: 5,
    parentName: 'Khun Nit',
    contactMethod: 'whatsapp',
    phone: '0899999902',
    mayOrderFood: false,
    confirmationsAccepted: true,
    serviceType: 'drop_off',
    status: 'registered',
    // Pre-paid demo booking (OTO-DEMO-DOP) — Schedule tab, payment-free check-in.
    scheduledFor: laterTodayISO(14, 0),
    bookedDurationMinutes: 60,
    registeredAt: '2026-06-27T09:00:00.000Z',
  },

  // ── Additional online-booked, ALREADY-PAID arrivals for later today ───────
  // These flesh out the Schedule tab so staff can demo the payment-free check-in
  // flow with a realistic mix of upcoming drop-off + nanny families. Each is a
  // status:'registered' + future scheduledFor record (the schedule-tab marker);
  // being on the schedule means it was booked online and paid, so the booked
  // (payment-free) check-in path takes no charge. Scheduled relative to NOW so
  // they always read as upcoming, never overdue, whenever the demo is run.

  // reg-101: drop-off, single child, prepaid food items already paid.
  {
    id: 'ci-101',
    registrationId: 'reg-101',
    childName: 'Nong Fern',
    childAge: 5,
    parentName: 'Khun Pakorn',
    contactMethod: 'whatsapp',
    phone: '+66810002001',
    allergiesMedical: 'Peanut allergy — antihistamine in bag',
    mayOrderFood: true,
    foodRestrictions: 'No nuts',
    confirmationsAccepted: true,
    serviceType: 'drop_off',
    status: 'registered',
    scheduledFor: minutesFromNowISO(75),
    bookedDurationMinutes: 120,
    registeredAt: minutesAgoISO(40),
    // Prepaid items paid at booking — redeemed at the F&B station, no charge here.
    foodProvision: {
      mode: 'prepaid_items',
      paidTHB: 190,
      items: [
        { menuItemId: 'm-nuggets', menuItemName: 'Chicken Nuggets', unitPriceTHB: 120, qty: 1, redeemedQty: 0 },
        { menuItemId: 'm-juice', menuItemName: 'Fresh Orange Juice', unitPriceTHB: 70, qty: 1, redeemedQty: 0 },
      ],
    },
    waConnection: { status: 'confirmed', sentAt: minutesAgoISO(40), confirmedAt: minutesAgoISO(38) },
  },

  // reg-102: nanny, single child, prepaid F&B credit already loaded.
  {
    id: 'ci-102',
    registrationId: 'reg-102',
    childName: 'Oliver',
    childAge: 4,
    parentName: 'Mrs. Bennett',
    contactMethod: 'whatsapp',
    phone: '+66820003002',
    mayOrderFood: true,
    confirmationsAccepted: true,
    serviceType: 'nanny',
    nannyStartTime: '14:30',
    status: 'registered',
    scheduledFor: minutesFromNowISO(135),
    bookedDurationMinutes: 180,
    registeredAt: minutesAgoISO(30),
    // Prepaid credit already paid online — loaded onto the band at check-in.
    foodProvision: {
      mode: 'prepaid_credit',
      creditAmountTHB: 200,
      paidTHB: 200,
    },
    waConnection: { status: 'confirmed', sentAt: minutesAgoISO(30), confirmedAt: minutesAgoISO(28) },
  },

  // reg-103: a TWO-child sibling family on one web form — one nanny + one
  // drop-off — so the multi-child booked check-in flow is demoable here too.
  {
    id: 'ci-103',
    registrationId: 'reg-103',
    childName: 'Nong Ice',
    childAge: 3,
    parentName: 'Khun Naree',
    contactMethod: 'whatsapp',
    phone: '+66830004003',
    allergiesMedical: 'Lactose intolerant',
    mayOrderFood: true,
    foodRestrictions: 'No dairy',
    confirmationsAccepted: true,
    serviceType: 'nanny',
    nannyStartTime: '15:00',
    status: 'registered',
    scheduledFor: minutesFromNowISO(190),
    bookedDurationMinutes: 120,
    registeredAt: minutesAgoISO(20),
    waConnection: { status: 'confirmed', sentAt: minutesAgoISO(20), confirmedAt: minutesAgoISO(18) },
  },
  {
    id: 'ci-104',
    registrationId: 'reg-103', // Nong Ice's sibling, same web-form submission
    childName: 'Nong Petch',
    childAge: 7,
    parentName: 'Khun Naree',
    contactMethod: 'whatsapp',
    phone: '+66830004003',
    mayOrderFood: true,
    confirmationsAccepted: true,
    serviceType: 'drop_off',
    status: 'registered',
    scheduledFor: minutesFromNowISO(190),
    bookedDurationMinutes: 120,
    registeredAt: minutesAgoISO(20),
    waConnection: { status: 'confirmed', sentAt: minutesAgoISO(20), confirmedAt: minutesAgoISO(18) },
  },

  // reg-104: drop-off, single child, no prepaid food (plain paid booking).
  {
    id: 'ci-105',
    registrationId: 'reg-104',
    childName: 'Sophia',
    childAge: 6,
    parentName: 'Mr. Rossi',
    contactMethod: 'telegram',
    phone: '+66840005004',
    mayOrderFood: false,
    confirmationsAccepted: true,
    serviceType: 'drop_off',
    status: 'registered',
    scheduledFor: minutesFromNowISO(255),
    bookedDurationMinutes: 90,
    registeredAt: minutesAgoISO(15),
    // Telegram contact — no WhatsApp connection check.
  },

  // reg-105: nanny, single child, later in the day, prepaid food items.
  {
    id: 'ci-106',
    registrationId: 'reg-105',
    childName: 'Nong Maprang',
    childAge: 4,
    parentName: 'Khun Siri',
    contactMethod: 'whatsapp',
    phone: '+66850006005',
    mayOrderFood: true,
    confirmationsAccepted: true,
    serviceType: 'nanny',
    nannyStartTime: '17:00',
    status: 'registered',
    scheduledFor: minutesFromNowISO(320),
    bookedDurationMinutes: 120,
    registeredAt: minutesAgoISO(10),
    foodProvision: {
      mode: 'prepaid_items',
      paidTHB: 90,
      items: [
        { menuItemId: 'm-juice', menuItemName: 'Fresh Orange Juice', unitPriceTHB: 70, qty: 1, redeemedQty: 0 },
      ],
    },
    waConnection: { status: 'confirmed', sentAt: minutesAgoISO(10), confirmedAt: minutesAgoISO(8) },
  },
];
// Stamp every seeded check-in with its home branch so the active-branch filter
// in getCheckIns() works correctly without a permissive "no branchId" fallback.
mockCheckIns.forEach((ci) => { ci.branchId ??= 'hkt-central'; });

/** All drop-off check-ins for the active branch, newest registration first. */
export const getCheckIns = (): CheckIn[] => {
  const bid = getActiveBranch().id;
  return [...mockCheckIns]
    .filter((c) => c.branchId === bid)
    .sort((a, b) => b.registeredAt.localeCompare(a.registeredAt));
};

/**
 * All children on one registration (shared registrationId). The signed drop-off
 * consent form lives at the BOOKING level, so one form covers the whole booking
 * — staff can add more children (and guardians) to the registration at check-in
 * via `addChildToRegistration` / `addGuardianToRegistration`.
 */
export const getCheckInsByRegistration = (registrationId: string): CheckIn[] => {
  const bid = getActiveBranch().id;
  return mockCheckIns
    .filter((c) => c.registrationId === registrationId && c.branchId === bid)
    .sort((a, b) => a.childName.localeCompare(b.childName));
}

/**
 * Registrations with a filled (consent-signed) form whose children haven't been
 * checked in yet — grouped by booking for the till's "Add drop-off" picker. Only
 * `registered` children appear (in-park/out are excluded); a registration drops
 * off the list once all its children are checked in. Newest booking first.
 */
export interface RegistrationGroup {
  registrationId: string;
  parentName: string;
  phone: string;
  children: CheckIn[]; // registered (awaiting check-in), sorted by child name
}

export const getRegistrationsAwaitingCheckIn = (): RegistrationGroup[] => {
  const bid = getActiveBranch().id;
  const byReg = new Map<string, CheckIn[]>();
  for (const c of mockCheckIns) {
    if (c.status !== 'registered') continue;
    if (c.branchId !== bid) continue;
    const list = byReg.get(c.registrationId) ?? [];
    list.push(c);
    byReg.set(c.registrationId, list);
  }
  return [...byReg.entries()]
    .map(([registrationId, children]) => {
      const sorted = [...children].sort((a, b) => a.childName.localeCompare(b.childName));
      return {
        registrationId,
        parentName: sorted[0]?.parentName ?? '',
        phone: sorted[0]?.phone ?? '',
        children: sorted,
      };
    })
    .sort((a, b) => {
      const aAt = a.children[0]?.registeredAt ?? '';
      const bAt = b.children[0]?.registeredAt ?? '';
      return bAt.localeCompare(aAt);
    });
};

// Booking-level authorized-pickup guardians. Seeded empty — added on the spot.
const mockGuardians: Guardian[] = [];

/** Authorized-pickup guardians attached to a registration (booking-level). */
export const getGuardiansByRegistration = (registrationId: string): Guardian[] =>
  mockGuardians
    .filter((g) => g.registrationId === registrationId)
    .sort((a, b) => a.addedAt.localeCompare(b.addedAt));

/**
 * Unified authorized-pickup list for a registration. Always starts with the
 * dropper-off/parent (derived from the registration's CheckIn data — always
 * present, read-only). Additional Guardians follow, sorted by addedAt.
 */
export const getAuthorizedPickups = (registrationId: string): AuthorizedPickup[] => {
  const rep = mockCheckIns.find((c) => c.registrationId === registrationId);
  const result: AuthorizedPickup[] = [];
  if (rep) {
    result.push({
      id: 'dropper_off',
      registrationId,
      name: rep.parentName,
      phone: rep.phone || undefined,
      photoUrl: rep.childPhotoUrl, // sign-up photo (child + parent together)
      isDropperOff: true,
      source: 'dropper_off',
      addedAt: rep.registeredAt,
    });
  }
  for (const g of mockGuardians.filter((g) => g.registrationId === registrationId).sort((a, b) => a.addedAt.localeCompare(b.addedAt))) {
    result.push({
      id: g.id,
      registrationId,
      name: g.name,
      phone: g.phone || undefined,
      relationship: g.relationship,
      photoUrl: g.photoUrl,
      isDropperOff: false,
      source: g.source,
      addedBy: g.addedBy,
      addedAt: g.addedAt,
    });
  }
  return result;
};

/**
 * POS action: add an authorized-pickup guardian to a registration. Consent is at
 * the booking level (one signed form covers the booking), so staff can register
 * extra pickup people at check-in. Stamped with the operator. In-memory only.
 */
export const addGuardianToRegistration = (
  registrationId: string,
  input: {
    name: string;
    phone?: string;
    relationship?: string;
    photoUrl?: string;
    source?: GuardianSource;
  },
  by?: { operatorName: string; operatorId?: string },
): Guardian | null => {
  const name = input.name.trim();
  if (!registrationId || !name) return null;
  const guardian: Guardian = {
    id: `grd-${Math.random().toString(36).substring(2, 9)}`,
    registrationId,
    name,
    phone: input.phone?.trim() ?? '',
    relationship: input.relationship?.trim() || undefined,
    photoUrl: input.photoUrl,
    source: input.source ?? 'in_person',
    addedBy: by?.operatorName,
    addedById: by?.operatorId,
    addedAt: new Date().toISOString(),
  };
  mockGuardians.push(guardian);
  return guardian;
};

/**
 * POS action: edit an existing authorized-pickup guardian. Stamped with the
 * operator. Only name, phone, relationship, and photoUrl may be updated.
 * In-memory only.
 */
export const editGuardian = (
  guardianId: string,
  updates: { name?: string; phone?: string; relationship?: string; photoUrl?: string },
  by?: { operatorName: string; operatorId?: string },
): Guardian | null => {
  const g = mockGuardians.find((g) => g.id === guardianId);
  if (!g) return null;
  if (updates.name !== undefined && updates.name.trim()) g.name = updates.name.trim();
  if (updates.phone !== undefined) g.phone = updates.phone.trim();
  if (updates.relationship !== undefined) g.relationship = updates.relationship.trim() || undefined;
  if (updates.photoUrl !== undefined) g.photoUrl = updates.photoUrl;
  g.updatedBy = by?.operatorName;
  g.updatedById = by?.operatorId;
  g.updatedAt = new Date().toISOString();
  return g;
};

/**
 * POS action: promote an inbound chat photo to an authorized-pickup person.
 * Copies the photo URL onto a new Guardian stamped with source='from_chat'.
 * Check-out staff see this person in the authorized list — they NEVER scroll
 * the chat thread.
 */
export const addPickupFromChatPhoto = (
  registrationId: string,
  input: { name: string; relationship?: string; phone?: string; imageUrl: string },
  by: { operatorName: string; operatorId: string },
): Guardian | null => {
  const name = input.name.trim();
  if (!registrationId || !name || !input.imageUrl) return null;
  const guardian: Guardian = {
    id: `grd-${Math.random().toString(36).substring(2, 9)}`,
    registrationId,
    name,
    phone: input.phone?.trim() ?? '',
    relationship: input.relationship?.trim() || undefined,
    photoUrl: input.imageUrl,
    source: 'from_chat',
    addedBy: by.operatorName,
    addedById: by.operatorId,
    addedAt: new Date().toISOString(),
  };
  mockGuardians.push(guardian);
  return guardian;
};

/**
 * POS action: add a child to an existing registration at check-in. Consent is at
 * the BOOKING level — one signed form covers the booking — so staff aren't
 * limited to the originally-registered siblings. The new child inherits the
 * booking's parent + contact details and lands as `registered`, ready to be
 * checked in within the same combined payment. In-memory only.
 */
export const addChildToRegistration = (
  registrationId: string,
  input: { name: string; age: number; dateOfBirth?: string; details?: string },
  _by?: { operatorName: string },
): CheckIn | null => {
  const name = input.name.trim();
  if (!registrationId || !name) return null;
  // Inherit parent/contact from any existing child on this booking.
  const sibling = mockCheckIns.find((c) => c.registrationId === registrationId);
  const child: CheckIn = {
    id: `ci-${Math.random().toString(36).substring(2, 9)}`,
    registrationId,
    branchId: getActiveBranch().id,
    childName: name,
    childAge: Number.isFinite(input.age) ? Math.max(0, Math.round(input.age)) : 0,
    dateOfBirth: input.dateOfBirth,
    parentName: sibling?.parentName ?? '',
    contactMethod: sibling?.contactMethod ?? 'whatsapp',
    phone: sibling?.phone ?? '',
    allergiesMedical: input.details?.trim() || undefined,
    mayOrderFood: sibling?.mayOrderFood ?? true,
    // Booking-level consent already signed (covers every child on the booking).
    confirmationsAccepted: true,
    serviceType: 'drop_off',
    status: 'registered',
    registeredAt: new Date().toISOString(),
  };
  mockCheckIns.push(child);
  return child;
};

/**
 * Door-flow action: register walk-in children discovered to need supervision at
 * the till (an unaccompanied ticket sale). Unlike addChildToRegistration these
 * have NO prior web-form booking, so we mint a fresh registration that all the
 * siblings share, and stamp the consent captured live on the customer screen
 * (parent name + acknowledgement + per-child allergy / food authorization /
 * photo). They land `registered` so checkInFamilyWithPayment can check them in
 * within the same payment. In-memory only.
 */
export const registerWalkInChildren = (
  children: {
    name: string;
    age: number;
    dateOfBirth?: string;
    service: DropOffServiceType;
    parentName: string;
    // Optional phone + contactMethod — the door/consent UI may capture these
    // so the auto-send WA confirmation can fire immediately. When omitted the
    // child is registered with a blank phone (no WA send, staff can add it later
    // via updateCheckIn, which re-triggers autoSendWaConfirmation automatically).
    phone?: string;
    contactMethod?: ContactChannel;
    allergiesMedical?: string;
    foodRestrictions?: string;
    mayOrderFood: boolean;
    foodProvision?: import('./types').ChildFoodProvision;
    childPhotoUrl?: string;
  }[],
  by?: {
    operatorName: string;
    // Confirmations checklist ticked once for the whole walk-in group on the
    // customer screen — mirrored onto every sibling's CheckIn (like
    // confirmationsAccepted below), since the acknowledgement covers them all.
    acknowledgedConfirmations?: import('./types').AcknowledgedConfirmation[];
  },
): CheckIn[] => {
  // One shared registration for the whole walk-in group (same parent/consent).
  const registrationId = `reg-walkin-${Math.random().toString(36).substring(2, 9)}`;
  const created = children.map((c) => {
    // Normalize the provision: a prepaid mode with paidTHB = 0 is invalid (e.g.
    // credit mode with an empty input or items mode with nothing selected).
    // Treat it as 'none' so ordering is never silently authorized without payment.
    const rawFp = c.foodProvision;
    const normalizedFp: import('./types').ChildFoodProvision | undefined = rawFp
      ? rawFp.mode !== 'none' && rawFp.paidTHB <= 0
        ? { mode: 'none', paidTHB: 0 }
        : rawFp
      : undefined;
    // Derive mayOrderFood from the normalized provision when one is supplied.
    const effectiveMayOrder = normalizedFp
      ? normalizedFp.mode !== 'none' && normalizedFp.paidTHB > 0
      : c.mayOrderFood;
    const child: CheckIn = {
      id: `ci-${Math.random().toString(36).substring(2, 9)}`,
      registrationId,
      branchId: getActiveBranch().id,
      childName: c.name.trim(),
      childAge: Number.isFinite(c.age) ? Math.max(0, Math.round(c.age)) : 0,
      dateOfBirth: c.dateOfBirth,
      childPhotoUrl: c.childPhotoUrl,
      parentName: c.parentName.trim(),
      contactMethod: c.contactMethod ?? 'whatsapp',
      phone: c.phone?.trim() ?? '',
      allergiesMedical: c.allergiesMedical?.trim() || undefined,
      mayOrderFood: effectiveMayOrder,
      foodRestrictions: c.foodRestrictions?.trim() || undefined,
      // Store the normalized provision so invalid modes can't leak into the check-in record.
      foodProvision: normalizedFp,
      // Consent was captured live at the till before this call (door flow).
      confirmationsAccepted: true,
      acknowledgedConfirmations: by?.acknowledgedConfirmations,
      serviceType: c.service,
      status: 'registered',
      registeredAt: new Date().toISOString(),
      assignedBy: by?.operatorName,
    };
    mockCheckIns.push(child);
    return child;
  });
  // Auto-send ONE WA connection check for the whole walk-in group after every
  // sibling is in mockCheckIns, so the message names all children (not just the
  // first). Phone may be blank for walk-ins captured without one; pick the first
  // child that has a phone, and autoSendWaConfirmation is a no-op when none do.
  const sender = created.find((c) => c.phone.trim()) ?? created[0];
  if (sender) autoSendWaConfirmation(sender);
  return created;
};

// In-memory audit trail of sibling-waiver authorizations taken at the door.
const mockSupervisionWaivers: SupervisionWaiver[] = [];

/** Read the door-flow supervision-waiver audit trail. */
export const getSupervisionWaivers = (): SupervisionWaiver[] => [...mockSupervisionWaivers];

/**
 * Door-flow action: record a staff-authorized sibling waiver. The younger
 * child's requirement is waived because an older sibling covers them; stamped
 * with the operator who approved it (waivers are never self-service). In-memory.
 */
export const recordSupervisionWaiver = (
  input: {
    childName: string;
    childAge: number;
    waivedRequirement: SupervisionWaiver['waivedRequirement'];
    coveringSiblingName: string;
    coveringSiblingAge: number;
  },
  by: { operatorName: string; operatorId: string },
): SupervisionWaiver => {
  const waiver: SupervisionWaiver = {
    id: `swv-${Math.random().toString(36).substring(2, 9)}`,
    childName: input.childName,
    childAge: input.childAge,
    waivedRequirement: input.waivedRequirement,
    coveringSiblingName: input.coveringSiblingName,
    coveringSiblingAge: input.coveringSiblingAge,
    waivedBy: by.operatorName,
    waivedById: by.operatorId,
    waivedAt: new Date().toISOString(),
  };
  mockSupervisionWaivers.push(waiver);
  return waiver;
};

/**
 * POS action: assign an available nanny to a check-in. Sets the nanny + flips
 * service to "nanny", stamped with the operator. In-memory only.
 */
export const assignNanny = (
  checkInId: string,
  nannyId: string,
  by: { operatorName: string },
): CheckIn | null => {
  const ci = mockCheckIns.find((c) => c.id === checkInId);
  const nanny = mockNannies.find((n) => n.id === nannyId);
  // Relaxed ratio: any on-shift nanny may be assigned — she can cover several
  // active children (especially siblings). No park-wide uniqueness check.
  if (!ci || !nanny || !nanny.available) return null;
  ci.assignedNannyId = nanny.id;
  ci.assignedNannyName = nanny.name;
  ci.serviceType = 'nanny';
  ci.assignedBy = by.operatorName;
  return ci;
};

/**
 * POS action: check a child into the park. Sets status + checkedInAt (drives the
 * live timer), stamped with the operator. In-memory only.
 */
export const enterPark = (
  checkInId: string,
  by: { operatorName: string },
): CheckIn | null => {
  const ci = mockCheckIns.find((c) => c.id === checkInId);
  if (!ci || ci.status !== 'registered') return null;
  ci.status = 'in_park';
  ci.checkedInAt = new Date().toISOString();
  ci.scheduledFor = undefined; // arrived, so it leaves the Schedule tab
  ci.checkedInBy = by.operatorName;
  return ci;
};

// Drop-off service pricing now lives in the editable catalog store
// (getDropOffPricing, re-exported above).

export interface CheckInPaymentInput {
  ticketTypeId: string;
  ticketName: string;
  tier: CustomerTier;
  ticketPriceTHB: number;
  serviceType: DropOffServiceType;
  serviceFeeTHB: number;
  durationHours: number;
  totalTHB: number;
  paymentMethod: string;
  nannyId?: string; // required for nanny service (strict 1:1)
  // Prepaid food provision captured at door consent. The mutator uses this to:
  //   prepaid_credit → top up the child's wristband creditBalanceTHB
  //   prepaid_items   → store the entitlements list on the wristband for the kitchen
  //   none            → no-op (mayOrderFood stays false on the band)
  foodProvision?: import('./types').ChildFoodProvision;
}

/**
 * POS action: the merged "Check in & pay" flow — take the park ticket + drop-off
 * service fee and check the child into the park in one step. Guards its own
 * invariants (like the other drop-off mutators): only from `registered`, and a
 * nanny service requires a still-available nanny enforcing the strict 1:1 ratio.
 * Sets status `in_park`, `checkedInAt` (drives the live timer) and
 * `bookedDurationMinutes` from the paid hours, and records the `checkInSale`
 * stamped with the operator. In-memory only. The caller also pushes the matching
 * Sale to the transaction-history store so it is refundable in Order History.
 */
export const checkInWithPayment = (
  checkInId: string,
  input: CheckInPaymentInput,
  by: { operatorName: string; operatorId: string },
): CheckIn | null => {
  const ci = mockCheckIns.find((c) => c.id === checkInId);
  if (!ci || ci.status !== 'registered') return null;

  if (input.serviceType === 'nanny') {
    const nanny = mockNannies.find((n) => n.id === input.nannyId);
    // Relaxed ratio: any on-shift nanny may supervise this child (and others).
    if (!nanny || !nanny.available) return null;
    ci.assignedNannyId = nanny.id;
    ci.assignedNannyName = nanny.name;
    ci.assignedBy = by.operatorName;
  } else {
    // Plain drop-off has no nanny: release any pre-assigned one so the strict
    // 1:1 roster doesn't keep her falsely occupied after check-in.
    ci.assignedNannyId = undefined;
    ci.assignedNannyName = undefined;
    ci.assignedBy = undefined;
  }

  ci.serviceType = input.serviceType;
  ci.status = 'in_park';
  const now = new Date().toISOString();
  ci.checkedInAt = now;
  ci.bookedDurationMinutes = Math.round(input.durationHours * 60);
  ci.scheduledFor = undefined; // arrived, so it leaves the Schedule tab
  ci.checkedInBy = by.operatorName;
  ci.checkInSale = {
    ticketTypeId: input.ticketTypeId,
    ticketName: input.ticketName,
    tier: input.tier,
    wristbandCode: mockWristbands.find((w) => w.checkInId === checkInId)?.code,
    ticketPriceTHB: input.ticketPriceTHB,
    serviceType: input.serviceType,
    serviceFeeTHB: input.serviceFeeTHB,
    durationHours: input.durationHours,
    totalTHB: input.totalTHB,
    paymentMethod: input.paymentMethod,
    paidBy: by.operatorName,
    paidById: by.operatorId,
    paidAt: now,
  };
  return ci;
};

/**
 * POS action: the multi-child ("family") merged Check in & pay — several siblings
 * on one registration checked in together against ONE combined payment. This is
 * the mutator-owned, ATOMIC version of `checkInWithPayment`: it validates EVERY
 * child up front (each still `registered`; each nanny on-shift, free park-wide,
 * and unique within this batch — the strict 1:1 ratio) and only commits once all
 * pass. If any child fails validation it mutates nothing and returns null, so a
 * combined sale is never recorded against a partial check-in. In-memory only; the
 * caller records the single matching Sale to Order History.
 */
export const checkInFamilyWithPayment = (
  items: { checkInId: string; input: CheckInPaymentInput }[],
  by: { operatorName: string; operatorId: string },
): CheckIn[] | null => {
  if (items.length === 0) return null;

  const resolved = items.map((it) => ({
    it,
    ci: mockCheckIns.find((c) => c.id === it.checkInId),
  }));

  // --- Validate all before committing any -----------------------------------
  // Relaxed ratio: one nanny may cover several of these siblings (and other park
  // children). We only require each nanny is on shift — no uniqueness check.
  for (const { it, ci } of resolved) {
    if (!ci || ci.status !== 'registered') return null;
    if (it.input.serviceType === 'nanny') {
      const nanny = mockNannies.find((n) => n.id === it.input.nannyId);
      if (!nanny || !nanny.available) return null;
    }
  }

  // --- Commit all ------------------------------------------------------------
  const now = new Date().toISOString();
  const out: CheckIn[] = [];
  for (const { it, ci } of resolved) {
    const c = ci!;
    if (it.input.serviceType === 'nanny') {
      const nanny = mockNannies.find((n) => n.id === it.input.nannyId)!;
      c.assignedNannyId = nanny.id;
      c.assignedNannyName = nanny.name;
      c.assignedBy = by.operatorName;
    } else {
      c.assignedNannyId = undefined;
      c.assignedNannyName = undefined;
      c.assignedBy = undefined;
    }
    c.serviceType = it.input.serviceType;
    c.status = 'in_park';
    c.checkedInAt = now;
    c.bookedDurationMinutes = Math.round(it.input.durationHours * 60);
    c.scheduledFor = undefined;
    c.checkedInBy = by.operatorName;
    c.checkInSale = {
      ticketTypeId: it.input.ticketTypeId,
      ticketName: it.input.ticketName,
      tier: it.input.tier,
      wristbandCode: mockWristbands.find((w) => w.checkInId === c.id)?.code,
      ticketPriceTHB: it.input.ticketPriceTHB,
      serviceType: it.input.serviceType,
      serviceFeeTHB: it.input.serviceFeeTHB,
      durationHours: it.input.durationHours,
      totalTHB: it.input.totalTHB,
      paymentMethod: it.input.paymentMethod,
      paidBy: by.operatorName,
      paidById: by.operatorId,
      paidAt: now,
    };

    // ---- Wristband food-provision loading -----------------------------------
    // Mint a band for this walk-in child if one doesn't already exist so we
    // have somewhere to store the provision.  Then load the provision onto it.
    const fp = it.input.foodProvision;
    if (fp) {
      let wb = mockWristbands.find((w) => w.checkInId === c.id);
      if (!wb && fp.mode !== 'none') {
        // Walk-in path: mint a band now (the till will print the bracelet).
        const newCode = `WI-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
        const fresh: Wristband = {
          id: `wb-${Math.random().toString(36).substring(2, 9)}`,
          code: newCode,
          customerNickname: c.childName,
          checkInId: c.id,
          holderName: c.childName,
          allergiesMedical: c.allergiesMedical,
          foodRestrictions: c.foodRestrictions,
          creditBalanceTHB: 0,
          mayOrderFood: true,
          gateAccess: false, // drop-off child: exits via check-out, never the gate
        };
        mockWristbands.push(fresh);
        wb = fresh;
      }
      if (wb) {
        // Store the full provision object so the F&B station can see the mode
        // and item entitlements.
        wb.foodProvision = fp;
        wb.mayOrderFood = fp.mode !== 'none';
        // prepaid_credit → top up the spendable balance and record the grant.
        if (fp.mode === 'prepaid_credit' && (fp.creditAmountTHB ?? 0) > 0) {
          const creditAmt = fp.creditAmountTHB ?? 0;
          wb.creditBalanceTHB = (wb.creditBalanceTHB ?? 0) + creditAmt;
          if (!wb.qrCode) wb.qrCode = `QR-${wb.id}`;
          if (!wb.ledger) wb.ledger = [];
          wb.ledger.push({
            kind: 'grant',
            amountTHB: creditAmt,
            source: 'prepaid_food',
            at: new Date().toISOString(),
            by: by.operatorName,
          });
        }
        // prepaid_items → entitlements are already in fp.items; no balance top-up.
      }
    }

    out.push(c);
  }
  return out;
};

/**
 * POS action: record one or more registered drop-off children as BOOKED but not
 * yet checked in — the door "Leave as booked" choice taken after a sale is paid.
 * Keeps status `registered`, stores the booked play-start time on `scheduledFor`
 * (so the children surface in the drop-off board's Schedule list) plus the booked
 * play length on `bookedDurationMinutes`, and stamps the operator. Issues NO band
 * and starts NO overstay timer — the children are checked in later through the
 * existing Schedule → check-in flow. Validates all-or-nothing: every item must
 * reference a still-`registered` child. In-memory only.
 */
export const markCheckInsBooked = (
  items: { checkInId: string; scheduledFor: string; bookedDurationMinutes?: number }[],
  by: { operatorName: string },
): CheckIn[] | null => {
  if (items.length === 0) return null;
  const resolved = items.map((it) => ({
    it,
    ci: mockCheckIns.find((c) => c.id === it.checkInId),
  }));
  // Validate all before committing any.
  for (const { ci } of resolved) {
    if (!ci || ci.status !== 'registered') return null;
  }
  const out: CheckIn[] = [];
  for (const { it, ci } of resolved) {
    const c = ci!;
    c.scheduledFor = it.scheduledFor;
    if (it.bookedDurationMinutes != null) c.bookedDurationMinutes = it.bookedDurationMinutes;
    c.assignedBy = by.operatorName;
    out.push(c);
  }
  return out;
};

/**
 * Drop-off board action: check a BOOKED (already-paid) registration into the
 * park WITHOUT taking any payment. This is the payment-free counterpart to
 * `checkInFamilyWithPayment` — booking-site pre-bookings and door "leave as
 * booked" children are paid for already, so check-in just runs the in-park
 * process: assign the nanny, capture consent/photo if it wasn't on file, load
 * any prepaid food onto the band, set `in_park` with the timer, and clear the
 * scheduled time. It records NO `checkInSale` (there is no new charge) and
 * never routes through the till.
 *
 * Atomic / all-or-nothing: validates every child up front (each still
 * `registered`; each nanny child resolves to an on-shift nanny) and only
 * commits once all pass, otherwise mutates nothing and returns null.
 * In-memory only; the caller dispatches the band print jobs.
 */
export const checkInFamilyBooked = (
  items: {
    checkInId: string;
    // For nanny-service children: the nanny chosen at check-in (assignment is
    // never done online). Falls back to any already-assigned nanny.
    nannyId?: string;
    // Optional play-length override (minutes). Defaults to the child's booked
    // duration stamped at booking / "leave as booked".
    durationMinutes?: number;
    // Consent + photo captured now ONLY when they weren't already on file.
    childPhotoUrl?: string;
    confirmationsAccepted?: boolean;
  }[],
  by: { operatorName: string; operatorId: string },
): CheckIn[] | null => {
  if (items.length === 0) return null;

  const resolved = items.map((it) => ({
    it,
    ci: mockCheckIns.find((c) => c.id === it.checkInId),
  }));

  // --- Validate all before committing any -----------------------------------
  for (const { it, ci } of resolved) {
    if (!ci || ci.status !== 'registered') return null;
    if (ci.serviceType === 'nanny') {
      const nannyId = it.nannyId ?? ci.assignedNannyId;
      const nanny = mockNannies.find((n) => n.id === nannyId);
      if (!nanny || !nanny.available) return null;
    }
  }

  // --- Commit all ------------------------------------------------------------
  const now = new Date().toISOString();
  const out: CheckIn[] = [];
  for (const { it, ci } of resolved) {
    const c = ci!;
    if (c.serviceType === 'nanny') {
      const nanny = mockNannies.find((n) => n.id === (it.nannyId ?? c.assignedNannyId))!;
      c.assignedNannyId = nanny.id;
      c.assignedNannyName = nanny.name;
      c.assignedBy = by.operatorName;
    } else {
      // Plain drop-off has no nanny: release any pre-assigned one.
      c.assignedNannyId = undefined;
      c.assignedNannyName = undefined;
      c.assignedBy = undefined;
    }
    // Capture consent / photo only if it wasn't already on file (booking-site
    // and door-booked children already have both; this is the edge-case path).
    if (it.childPhotoUrl && !c.childPhotoUrl) c.childPhotoUrl = it.childPhotoUrl;
    if (it.confirmationsAccepted && !c.confirmationsAccepted) c.confirmationsAccepted = true;

    c.status = 'in_park';
    c.checkedInAt = now;
    if (it.durationMinutes != null) c.bookedDurationMinutes = it.durationMinutes;
    c.scheduledFor = undefined;
    c.checkedInBy = by.operatorName;
    // No checkInSale — this booking was paid for at booking time, not now.

    // ---- Wristband food-provision loading (mirrors checkInFamilyWithPayment) --
    const fp = c.foodProvision;
    if (fp) {
      let wb = mockWristbands.find((w) => w.checkInId === c.id);
      if (!wb && fp.mode !== 'none') {
        const newCode = `WI-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
        const fresh: Wristband = {
          id: `wb-${Math.random().toString(36).substring(2, 9)}`,
          code: newCode,
          customerNickname: c.childName,
          checkInId: c.id,
          holderName: c.childName,
          allergiesMedical: c.allergiesMedical,
          foodRestrictions: c.foodRestrictions,
          creditBalanceTHB: 0,
          mayOrderFood: true,
          gateAccess: false, // drop-off child: exits via check-out, never the gate
        };
        mockWristbands.push(fresh);
        wb = fresh;
      }
      if (wb) {
        wb.foodProvision = fp;
        wb.mayOrderFood = fp.mode !== 'none';
        if (fp.mode === 'prepaid_credit' && (fp.creditAmountTHB ?? 0) > 0) {
          const creditAmt = fp.creditAmountTHB ?? 0;
          wb.creditBalanceTHB = (wb.creditBalanceTHB ?? 0) + creditAmt;
          if (!wb.qrCode) wb.qrCode = `QR-${wb.id}`;
          if (!wb.ledger) wb.ledger = [];
          wb.ledger.push({
            kind: 'grant',
            amountTHB: creditAmt,
            source: 'prepaid_food',
            at: new Date().toISOString(),
            by: by.operatorName,
          });
        }
      }
    }

    out.push(c);
  }
  return out;
};

/**
 * Link a recorded Sale's ID back to a check-in's `checkInSale` so the checkout
 * flow can always locate the originating transaction deterministically.
 * Call this immediately after `recordSale` for every drop-off child in the sale.
 */
export const linkCheckInSaleId = (checkInId: string, saleId: string): void => {
  const ci = mockCheckIns.find((c) => c.id === checkInId);
  if (ci?.checkInSale) ci.checkInSale.saleId = saleId;
};

/**
 * Store the sign-up photo (child + parent / guardian together) on an existing
 * CheckIn without touching any other fields. Used by the mobile consent flow
 * (HandToCustomer) where the child is already registered and the photo is
 * captured at walk-in. Only sets when the new value is non-empty and the
 * record has none (never overwrites a photo already on file). In-memory only.
 */
export const applyCheckInPhotos = (
  checkInId: string,
  photos: { childPhotoUrl?: string },
): void => {
  const ci = mockCheckIns.find((c) => c.id === checkInId);
  if (!ci) return;
  if (photos.childPhotoUrl && !ci.childPhotoUrl) ci.childPhotoUrl = photos.childPhotoUrl;
};

/**
 * POS action: check a child out of the park. Sets status + checkedOutAt, stamped
 * with the operator. When `prepaidReconciliation` is provided and `unusedTHB > 0`,
 * applies the configured policy:
 *   'refund'  → a refund of the unused amount is recorded against the check-in sale
 *               in Order History (operator-stamped, visible to the refunds report).
 *   'forfeit' → no cash movement; the forfeited amount is stamped on the CheckIn
 *               for reporting.
 * In-memory only.
 */
export const checkOut = (
  checkInId: string,
  by: { operatorName: string; operatorId: string },
  pickupPhotoUrl: string,
  prepaidReconciliation: { unusedTHB: number; policy: 'refund' | 'forfeit' } | undefined,
  collectorInput: {
    pickupId: string;
    name: string;
    relationship?: string;
    isDropperOff: boolean;
    source: AuthorizedPickupSource;
  },
): CheckIn | null => {
  const ci = mockCheckIns.find((c) => c.id === checkInId);
  if (!ci || ci.status !== 'in_park') return null;
  // Safety invariant: a pickup photo must be captured before release. The UI
  // also enforces this, but the mutator guards it so direct calls can't bypass.
  if (!pickupPhotoUrl?.trim()) return null;
  ci.status = 'out';
  const now = new Date().toISOString();
  ci.checkedOutAt = now;
  ci.checkedOutBy = by.operatorName;
  ci.checkedOutById = by.operatorId;
  ci.pickupPhotoUrl = pickupPhotoUrl;
  if (collectorInput) {
    ci.collectorRecord = {
      ...collectorInput,
      verifiedBy: by.operatorName,
      verifiedById: by.operatorId,
      verifiedAt: now,
    };
  }

  // --- Prepaid food settlement -----------------------------------------------
  if (prepaidReconciliation && prepaidReconciliation.unusedTHB > 0) {
    const { unusedTHB, policy } = prepaidReconciliation;
    let refundId: string | undefined;
    let settlementError: 'refund_no_sale' | undefined;

    if (policy === 'refund') {
      // Prefer the deterministic saleId stored by linkCheckInSaleId() immediately
      // after recordSale(). Fall back to a scan of drop-off lines only when the
      // link hasn't been stamped (e.g. seeded data that pre-dates the link call).
      const saleId = ci.checkInSale?.saleId;
      const sale = saleId
        ? recordedSales.find((s) => s.id === saleId)
        : recordedSales.find((s) => s.lines.some((l) => l.dropOff?.checkInId === checkInId));

      if (sale) {
        const { refund } = recordRefund({
          transactionId: sale.id,
          kind: 'ticket',
          scope: 'partial',
          amountTHB: unusedTHB,
          creditRestoredTHB: 0, // food credit is consumed, not restored to the band
          reason: 'Unused prepaid food at pickup',
          refundedBy: by.operatorName,
          refundedById: by.operatorId,
        });
        refundId = refund.id;
      } else {
        // Explicit failure: the originating sale is not in history (e.g. data
        // existed before the session's in-memory ledger). Staff must refund manually.
        settlementError = 'refund_no_sale';
      }
    }

    ci.prepaidFoodSettlement = {
      policy,
      unusedTHB,
      refundId,
      settlementError,
      settledAt: now,
      settledBy: by.operatorName,
      settledById: by.operatorId,
    };
  }

  // Checking out frees the child's nanny (availability is derived from status).
  return ci;
};

/**
 * POS action: a scheduled child has arrived — clear scheduledFor so they move
 * from the Schedule tab into Registered, stamped with the operator. Guards the
 * transition (only a scheduled, still-registered child can arrive). In-memory only.
 */
export const markArrived = (
  checkInId: string,
  by: { operatorName: string },
): CheckIn | null => {
  const ci = mockCheckIns.find((c) => c.id === checkInId);
  if (!ci || ci.status !== 'registered' || !ci.scheduledFor) return null;
  ci.scheduledFor = undefined;
  ci.arrivedBy = by.operatorName;
  return ci;
};

// Editable registration fields (the parent web-form details staff may correct).
export interface CheckInEdits {
  childName: string;
  childAge: number;
  parentName: string;
  contactMethod: ContactChannel;
  phone: string;
  serviceType: DropOffServiceType;
  mayOrderFood: boolean;
  foodRestrictions?: string;
  allergiesMedical?: string;
  bookedDurationMinutes?: number;
  assignedNannyId?: string;
}

let nextChangeLogId = 1;
const noneLabel = '—';

/**
 * POS action: edit a check-in's registration details. Diffs each field and
 * appends an audited ChangeLogEntry (stamped with the operator) for every change.
 * In production the change log also pushes to the HR Activity Logbook. In-memory only.
 */
export const updateCheckIn = (
  checkInId: string,
  edits: CheckInEdits,
  by: { operatorName: string; operatorId: string },
): CheckIn | null => {
  const ci = mockCheckIns.find((c) => c.id === checkInId);
  if (!ci) return null;

  // Relaxed ratio guard (mirrors assignNanny): if this edit assigns a nanny, she
  // need only be on shift — she may already be covering other active children.
  if (edits.assignedNannyId) {
    const onShift = getNannyRoster(checkInId).find(
      (r) => r.id === edits.assignedNannyId && r.available,
    );
    if (!onShift) return null;
  }

  const changedAt = new Date().toISOString();
  const log = (ci.changeLog ??= []);
  const record = (field: string, oldValue: string, newValue: string) => {
    if (oldValue === newValue) return;
    log.push({
      id: `cl-${nextChangeLogId++}`,
      field,
      oldValue,
      newValue,
      changedBy: by.operatorName,
      changedById: by.operatorId,
      changedAt,
    });
  };
  const serviceLabel = (s: DropOffServiceType) => (s === 'nanny' ? 'Nanny' : 'Drop-Off');
  const durLabel = (m?: number) => (m != null ? `${m} min` : noneLabel);
  const nannyLabel = (id?: string) =>
    id ? (mockNannies.find((n) => n.id === id)?.name ?? noneLabel) : noneLabel;

  const nextFood = edits.foodRestrictions?.trim() || undefined;
  const nextAllergy = edits.allergiesMedical?.trim() || undefined;

  // Capture old values before mutation for WA re-trigger check below.
  const oldPhone = ci.phone;
  const oldContactMethod = ci.contactMethod;

  record('Child name', ci.childName, edits.childName);
  record('Age', String(ci.childAge), String(edits.childAge));
  record('Parent name', ci.parentName, edits.parentName);
  record('Contact method', ci.contactMethod, edits.contactMethod);
  record('Phone', ci.phone, edits.phone);
  record('Service', serviceLabel(ci.serviceType), serviceLabel(edits.serviceType));
  record('May order food', ci.mayOrderFood ? 'Yes' : 'No', edits.mayOrderFood ? 'Yes' : 'No');
  record('Food restrictions', ci.foodRestrictions ?? noneLabel, nextFood ?? noneLabel);
  record('Allergies / medical', ci.allergiesMedical ?? noneLabel, nextAllergy ?? noneLabel);
  record('Booked play time', durLabel(ci.bookedDurationMinutes), durLabel(edits.bookedDurationMinutes));
  record('Nanny', ci.assignedNannyName ?? noneLabel, nannyLabel(edits.assignedNannyId));

  ci.childName = edits.childName;
  ci.childAge = edits.childAge;
  ci.parentName = edits.parentName;
  ci.contactMethod = edits.contactMethod;
  ci.phone = edits.phone;
  ci.serviceType = edits.serviceType;
  ci.mayOrderFood = edits.mayOrderFood;
  ci.foodRestrictions = nextFood;
  ci.allergiesMedical = nextAllergy;
  ci.bookedDurationMinutes = edits.bookedDurationMinutes;
  if (edits.assignedNannyId) {
    const n = mockNannies.find((nn) => nn.id === edits.assignedNannyId);
    if (n) {
      ci.assignedNannyId = n.id;
      ci.assignedNannyName = n.name;
    }
  } else {
    ci.assignedNannyId = undefined;
    ci.assignedNannyName = undefined;
  }

  // Re-trigger or clear the connection check on phone / channel edits. Rule:
  // the stored waConnection must never contradict the current phone value — a
  // green "confirmed" chip with a blank phone would hide a broken channel.
  // Same mocked send→pending→confirmed loop applies regardless of channel.
  const phoneChanged = ci.phone !== oldPhone;
  const channelChanged = ci.contactMethod !== oldContactMethod;

  if (!ci.phone.trim()) {
    // Phone was cleared — reset to unverified so the chip shows red and the
    // flagged filter catches this record. Never leave a confirmed/pending state
    // orphaned on a blank phone.
    for (const s of regSiblings(ci)) s.waConnection = undefined;
    ci.waConnection = undefined;
  } else if (phoneChanged || channelChanged) {
    // New non-empty phone (or channel switch) — send a fresh confirmation.
    // resendWaConfirmation always stamps all siblings 'pending', bypassing the
    // auto-send dedup short-circuit that would wrongly skip a re-send here.
    resendWaConfirmation(ci.id);
  }

  return ci;
};

// --- WhatsApp Business messaging --------------------------------------------
// In-app messaging with parents via the WhatsApp Business integration. This is
// the POS-side of messaging; in production it shares the WhatsApp Business inbox
// with the wider Oto app. Module-memory only (no storage).

const waTemplates: WaTemplate[] = [
  // Connection-check template: auto-sent on every new drop-off registration with
  // a WhatsApp number. In production this requires a Meta-approved button template.
  {
    id: 'tpl-confirm-connection',
    name: 'Connection check',
    category: 'drop_off',
    body: "Hi {parentName}, {childName} has just been registered at Oto. Please tap the button below to confirm we have the right number — we'll use it for emergency updates during your child's session.",
    buttons: [{ id: 'confirm', label: 'Confirm received ✓' }],
  },
  {
    id: 'tpl-checked-in',
    name: 'Checked in ✓',
    category: 'drop_off',
    body: "Hi {parentName}, {childName} is safely checked in. We'll message you when it's time to collect.",
  },
  {
    id: 'tpl-time-almost-up',
    name: 'Time almost up',
    category: 'drop_off',
    body: "Hi {parentName}, {childName}'s session ends at {time}. Please head back to reception.",
  },
  {
    id: 'tpl-please-collect',
    name: 'Please collect',
    category: 'drop_off',
    body: 'Hi {parentName}, {childName} is ready for pickup at reception.',
  },
  {
    id: 'tpl-booking-confirmed',
    name: 'Booking confirmed',
    category: 'party',
    body: 'Hi {parentName}, your party booking is confirmed. We look forward to celebrating with you!',
  },
  {
    id: 'tpl-balance-reminder',
    name: 'Balance reminder',
    category: 'party',
    body: 'Hi {parentName}, a friendly reminder that there is an outstanding balance on your party booking. Please settle it before the event so check-in is smooth.',
  },
  {
    id: 'tpl-party-today',
    name: 'Party today reminder',
    category: 'party',
    body: 'Hi {parentName}, just a reminder that your party is today at {time}. See you soon!',
  },
  { id: 'tpl-custom', name: 'Custom message', category: 'general', body: '' },
];

export const getMessageTemplates = (): WaTemplate[] => waTemplates;

// Threads keyed by normalized phone (via normalizePhone above) so a thread
// matches regardless of spacing / leading "+". Seeded for a few recipients so
// the panel isn't empty; new outbound messages are appended in place.
const waThreads: Record<string, WaMessage[]> = {
  // Nong Mali / Khun Ratana drop-off (+66818953926)
  '66818953926': [
    {
      id: 'wa-seed-1',
      recipientPhone: '+66818953926',
      direction: 'outbound',
      body: 'Hi Khun Ratana, Nong Mali is safely checked in. We will message you when it is time to collect.',
      templateId: 'tpl-checked-in',
      status: 'read',
      sentBy: 'Nok',
      sentById: 'op-1',
      at: new Date(Date.now() - 95 * 60_000).toISOString(),
    },
    {
      id: 'wa-seed-2',
      recipientPhone: '+66818953926',
      direction: 'inbound',
      body: 'Thank you so much! She was very excited 😊',
      status: 'read',
      at: new Date(Date.now() - 92 * 60_000).toISOString(),
    },
  ],
  // Sophia's party / Khun Ploy (+66 81 234 5678)
  '66812345678': [
    {
      id: 'wa-seed-3',
      recipientPhone: '+66 81 234 5678',
      direction: 'outbound',
      body: 'Hi Khun Ploy, your party booking is confirmed. We look forward to celebrating with you!',
      templateId: 'tpl-booking-confirmed',
      status: 'delivered',
      sentBy: 'Nok',
      sentById: 'op-1',
      at: new Date(Date.now() - 26 * 60 * 60_000).toISOString(),
    },
  ],
};

export const getThread = (recipientPhone: string): WaMessage[] =>
  waThreads[normalizePhone(recipientPhone)] ?? [];

// Seed the connection-check conversation for the pre-seeded WhatsApp drop-off
// registrations. Live registrations append this outbound message (and any confirm
// reply) to the thread via autoSendWaConfirmation/simulateWaConfirm, but the static
// seed check-ins set waConnection inline — so without this the thread would be
// missing the very message we "sent" the parent. One message per registration
// channel (deduped by registrationId), mirroring production.
(() => {
  const ccTpl = waTemplates.find((t) => t.id === 'tpl-confirm-connection');
  if (!ccTpl) return;
  let seedId = 1;
  const seededRegs = new Set<string>();
  for (const ci of mockCheckIns) {
    if (!ci.phone.trim() || !ci.waConnection) continue;
    if (seededRegs.has(ci.registrationId)) continue;
    seededRegs.add(ci.registrationId);

    const { status, sentAt, confirmedAt } = ci.waConnection;
    const thread = (waThreads[normalizePhone(ci.phone)] ??= []);
    const body = ccTpl.body
      .replaceAll('{parentName}', ci.parentName)
      .replaceAll('{childName}', regChildNamesText(ci.registrationId));
    thread.push({
      id: `wa-seed-cc-${seedId++}`,
      recipientPhone: ci.phone,
      direction: 'outbound',
      body,
      templateId: ccTpl.id,
      status: status === 'failed' ? 'failed' : status === 'confirmed' ? 'read' : 'delivered',
      at: sentAt ?? ci.registeredAt,
    });
    if (status === 'confirmed') {
      thread.push({
        id: `wa-seed-cc-${seedId++}`,
        recipientPhone: ci.phone,
        direction: 'inbound',
        body: 'Confirm received ✓',
        status: 'read',
        at: confirmedAt ?? sentAt ?? ci.registeredAt,
      });
    }
    thread.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  }
})();

let nextWaId = 1;

/**
 * POS action: send an outbound WhatsApp message to a parent. Appends the message
 * to the recipient's thread stamped with the operator + time and returns it with
 * status 'sending'. The caller animates the status progression and reports each
 * step back via updateMessageStatus so the stored thread stays in sync.
 *
 * Real send goes through the WhatsApp Business API via the chosen BSP. Free-text
 * is only allowed inside an open 24h customer-service window; outside it, only
 * approved templates can be sent.
 */
export const sendWhatsAppMessage = (params: {
  recipientPhone: string;
  body: string;
  templateId?: string;
  sentBy?: string;
  sentById?: string;
}): WaMessage => {
  const key = normalizePhone(params.recipientPhone);
  const message: WaMessage = {
    id: `wa-${nextWaId++}`,
    recipientPhone: params.recipientPhone,
    direction: 'outbound',
    body: params.body,
    templateId: params.templateId,
    status: 'sending',
    sentBy: params.sentBy,
    sentById: params.sentById,
    at: new Date().toISOString(),
  };
  (waThreads[key] ??= []).push(message);
  return message;
};

// Keep the stored thread message in sync as the caller animates the delivery
// status (sending -> sent -> delivered -> read).
export const updateMessageStatus = (id: string, status: MessageStatus): void => {
  for (const thread of Object.values(waThreads)) {
    const msg = thread.find((m) => m.id === id);
    if (msg) {
      msg.status = status;
      return;
    }
  }
};

// --- WhatsApp connection check -----------------------------------------------
// Auto-sent when a drop-off registration captures a WhatsApp phone number.
// Scoped per-registration: one message per parent channel, status kept in sync
// across all siblings (same registrationId) so the board always shows a coherent
// view — a single parent's WA reachability, not a per-child status.

/** Return all CheckIns in mockCheckIns sharing the same registrationId. */
const regSiblings = (ci: CheckIn) =>
  mockCheckIns.filter((c) => c.registrationId === ci.registrationId);

/** Join names as "A", "A and B", or "A, B and C" for parent-facing copy. */
function formatNameList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * All children's names for a registration, formatted for ONE parent-facing
 * message — a single WhatsApp channel per parent covers every sibling, so the
 * connection-check / registration confirmation must name them all. Sorted by
 * name for stable copy. Reads mockCheckIns directly so it is safe to call from
 * the module-load seed (regSiblings is still in TDZ there).
 */
function regChildNamesText(registrationId: string): string {
  return formatNameList(
    mockCheckIns
      .filter((c) => c.registrationId === registrationId)
      .map((c) => c.childName)
      .sort((a, b) => a.localeCompare(b)),
  );
}

/**
 * Internal: send the connection-check confirmation template to the parent and
 * stamp waConnection = 'pending' on the given CheckIn AND all of its siblings
 * already in mockCheckIns (same registrationId).
 *
 * Safe to call before the CheckIn is pushed (the ci object is stamped directly).
 * When multiple children share a registration the callers process them in
 * registration order, pushing each before processing the next — so siblings
 * processed later find the first child in mockCheckIns and mirror its status
 * without sending a second message (one send per registration/channel).
 *
 * Works identically for whatsapp/telegram/line — same mocked send→pending→
 * confirmed loop for all three. No-op when phone is empty.
 */
const autoSendWaConfirmation = (ci: CheckIn): void => {
  if (!ci.phone.trim()) return;

  // If any sibling already has a waConnection the channel check was already
  // sent this registration — mirror the existing status without sending again.
  const existing = regSiblings(ci).find((s) => s.waConnection)?.waConnection;
  if (existing) {
    ci.waConnection = { ...existing };
    return;
  }

  // First child in this registration: send the template and stamp all siblings.
  const tpl = waTemplates.find((t) => t.id === 'tpl-confirm-connection');
  if (!tpl) return;
  const body = tpl.body
    .replaceAll('{parentName}', ci.parentName)
    .replaceAll('{childName}', regChildNamesText(ci.registrationId));
  const msg = sendWhatsAppMessage({ recipientPhone: ci.phone, body, templateId: tpl.id });
  const stamp = { status: 'pending' as const, sentAt: msg.at };
  ci.waConnection = stamp;
  // Sync all siblings already in mockCheckIns.
  for (const s of regSiblings(ci)) {
    s.waConnection = stamp;
  }
};

/**
 * Staff action: re-send the connection-check template to a registered parent.
 * Sends one message and resets waConnection to 'pending' on every CheckIn in
 * the same registration (one parent channel = one status across all siblings).
 */
export const resendWaConfirmation = (checkInId: string): CheckIn | null => {
  const ci = mockCheckIns.find((c) => c.id === checkInId);
  if (!ci || !ci.phone.trim()) return null;
  const tpl = waTemplates.find((t) => t.id === 'tpl-confirm-connection');
  if (!tpl) return null;
  const body = tpl.body
    .replaceAll('{parentName}', ci.parentName)
    .replaceAll('{childName}', regChildNamesText(ci.registrationId));
  const msg = sendWhatsAppMessage({ recipientPhone: ci.phone, body, templateId: tpl.id });
  const stamp = { ...(ci.waConnection ?? {}), status: 'pending' as const, sentAt: msg.at };
  for (const s of regSiblings(ci)) {
    s.waConnection = stamp;
  }
  ci.waConnection = stamp;
  return ci;
};

/**
 * Dev/sim action: simulate the parent tapping the "Confirm received" quick-reply
 * button. In production this is triggered by the BSP's inbound webhook delivering
 * the button-reply event. Appends a simulated inbound WaMessage to the thread and
 * flips waConnection.status to 'confirmed' on every sibling in the registration.
 */
export const simulateWaConfirm = (checkInId: string): CheckIn | null => {
  const ci = mockCheckIns.find((c) => c.id === checkInId);
  if (!ci || ci.waConnection?.status !== 'pending') return null;
  const now = new Date().toISOString();
  const key = normalizePhone(ci.phone);
  const inbound: WaMessage = {
    id: `wa-${nextWaId++}`,
    recipientPhone: ci.phone,
    direction: 'inbound',
    body: 'Confirm received ✓',
    status: 'read',
    at: now,
  };
  (waThreads[key] ??= []).push(inbound);
  const stamp = { ...(ci.waConnection ?? {}), status: 'confirmed' as const, confirmedAt: now };
  for (const s of regSiblings(ci)) {
    s.waConnection = stamp;
  }
  ci.waConnection = stamp;
  return ci;
};

/**
 * Dev/sim action: inject a simulated inbound photo message into a parent's thread.
 * Models a parent sending a photo via WhatsApp (e.g. of someone collecting the child).
 * In production this arrives via the BSP inbound webhook. Front-end only — stays
 * in-memory; the photo is a placeholder URL for the demo.
 */
let nextSimPhotoId = 1;
export const injectInboundPhotoMessage = (
  recipientPhone: string,
  caption = '📷 Here is a photo of my husband who will collect',
): WaMessage => {
  const key = normalizePhone(recipientPhone);
  // Placeholder gradient image that clearly looks like a person photo (demo).
  const imageUrl = `https://placehold.co/300x300/1e293b/94a3b8?text=Parent+Photo`;
  const msg: WaMessage = {
    id: `wa-photo-${nextSimPhotoId++}`,
    recipientPhone,
    direction: 'inbound',
    body: caption,
    imageUrl,
    status: 'read',
    at: new Date().toISOString(),
  };
  (waThreads[key] ??= []).push(msg);
  return msg;
};

/**
 * Staff action: mark a WhatsApp connection as failed — the parent cannot be
 * reached on this number. Staff should prompt the parent to update their phone.
 * Updates every sibling in the registration (one parent channel = one status).
 * Works whether or not a connection check was previously sent ('unverified' case).
 */
export const markWaConnectionFailed = (checkInId: string): CheckIn | null => {
  const ci = mockCheckIns.find((c) => c.id === checkInId);
  if (!ci) return null;
  const stamp = { ...(ci.waConnection ?? {}), status: 'failed' as const };
  for (const s of regSiblings(ci)) {
    s.waConnection = stamp;
  }
  ci.waConnection = stamp;
  return ci;
};
