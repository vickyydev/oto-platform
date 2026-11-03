import { trustedBoxBridgeOrigin } from '@oto/shared';
import type { ApiStation } from '@/api/platform';
import { prepareCatalog, type PreparedCatalog } from '@/api/catalogBridge';
import type { Operator, ScannerMode } from '@/types';

const KEY = 'oto.pos.offline-preparation.v1';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
let preparedOperator: Operator | null = null;

/** No password, session credential, permission grant, customer or open sale. */
export interface OfflinePreparation {
  version: 1;
  savedAt: number;
  operator: Operator;
  station: ApiStation;
  scannerMode?: ScannerMode;
  catalog: PreparedCatalog;
}

export function forgetOfflinePreparation(): void {
  preparedOperator = null;
  forgetOfflineStation();
}

/** Changing stations clears its saved copy, while this online sign-in remains eligible. */
export function forgetOfflineStation(): void {
  try { window.localStorage.removeItem(KEY); } catch { /* Site data may be blocked. */ }
}

/** Only a complete ordinary online sign-in can prepare this device. */
export function prepareOfflineOperator(operator: Operator, eligible: boolean): void {
  if (!eligible) { forgetOfflinePreparation(); return; }
  const previous = readOfflinePreparation();
  if (previous && previous.operator.id !== operator.id) forgetOfflinePreparation();
  preparedOperator = { id: operator.id, name: operator.name, role: 'staff' };
}

export function prepareOfflineStation(station: ApiStation, branchSlug: string, scannerMode?: ScannerMode): void {
  const catalog = prepareCatalog(branchSlug);
  const origin = trustedBoxBridgeOrigin(station.bridgeOrigin, import.meta.env.VITE_BOX_BRIDGE_ZONE,
    import.meta.env.VITE_BOX_BRIDGE_ALLOW_LOOPBACK === 'true');
  if (!preparedOperator || !catalog || !origin || catalog.branch.id !== station.branchId
    || !station.boxId || station.archived || station.ready === false) {
    try { window.localStorage.removeItem(KEY); } catch { /* No usable preparation. */ }
    return;
  }
  const saved: OfflinePreparation = { version: 1, savedAt: Date.now(), operator: preparedOperator,
    station: { ...station, bridgeOrigin: origin, staff: [] }, scannerMode, catalog };
  try { window.localStorage.setItem(KEY, JSON.stringify(saved)); } catch { /* Online work still proceeds. */ }
}

/** This is a lock-screen address book and catalogue, never authentication. */
export function readOfflinePreparation(now = Date.now()): OfflinePreparation | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw || raw.length > 2_000_000) return null;
    const saved = JSON.parse(raw) as OfflinePreparation;
    const uuid = (value: unknown) => typeof value === 'string'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
    if (saved.version !== 1 || !Number.isFinite(saved.savedAt) || now < saved.savedAt
      || now - saved.savedAt > MAX_AGE_MS || !uuid(saved.operator?.id)
      || typeof saved.operator.name !== 'string' || !uuid(saved.station?.id)
      || !uuid(saved.station.boxId) || saved.station.archived || saved.station.ready === false
      || typeof saved.station.name !== 'string' || typeof saved.station.kind !== 'string'
      || !uuid(saved.catalog?.branch?.id) || saved.catalog.branch.id !== saved.station.branchId
      || typeof saved.catalog.branch.name !== 'string' || saved.catalog.branch.archived
      || typeof saved.catalog.branch.code !== 'string' || typeof saved.catalog.branch.timezone !== 'string'
      || (saved.station.devices !== undefined && !Array.isArray(saved.station.devices))
      || (saved.station.capabilities !== undefined && (!Array.isArray(saved.station.capabilities)
        || !saved.station.capabilities.every(value => typeof value === 'string')))) return null;
    // A corrupted time zone must not throw later while rendering the lock screen.
    new Intl.DateTimeFormat('en', { timeZone: saved.catalog.branch.timezone }).format(now);
    const origin = trustedBoxBridgeOrigin(saved.station.bridgeOrigin, import.meta.env.VITE_BOX_BRIDGE_ZONE,
      import.meta.env.VITE_BOX_BRIDGE_ALLOW_LOOPBACK === 'true');
    if (!origin) return null;
    const catalog = saved.catalog.catalog;
    if (!catalog || !catalog.taxConfig || !catalog.dropOffPricing || !catalog.supervisionPolicy
      || !['tiers', 'ticketTypes', 'addOns', 'menuItems', 'menuCategories', 'merchItems', 'modifierGroups',
        'discounts', 'paymentMethods', 'pricingOverrides', 'inventory', 'stockLocations', 'devices',
        'edcTerminals', 'printTemplates'].every(key => Array.isArray(catalog[key as keyof typeof catalog]))) return null;
    saved.operator = { id: saved.operator.id, name: saved.operator.name, role: 'staff' };
    saved.station.bridgeOrigin = origin;
    return saved;
  } catch { return null; }
}
