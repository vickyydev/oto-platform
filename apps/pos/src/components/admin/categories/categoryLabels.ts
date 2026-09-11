import type { PrepStation, TaxableCategory } from '@/types';

// Prep stations a category can default its items to. 'none' = no prep ticket
// (e.g. pre-packaged snacks handed over at the till).
export const PREP_STATION_OPTIONS: PrepStation[] = ['kitchen', 'bar', 'none'];

export const PREP_STATION_LABELS: Record<PrepStation, string> = {
  kitchen: 'Kitchen',
  bar: 'Bar',
  none: 'No prep ticket',
};

// F&B lines are taxed as either general F&B or the alcohol (bar) area.
export const TAX_CATEGORY_OPTIONS: TaxableCategory[] = ['fnb', 'bar'];

export const TAX_CATEGORY_LABELS: Record<TaxableCategory, string> = {
  tickets: 'Tickets',
  fnb: 'F&B',
  bar: 'Bar (alcohol)',
  merch: 'Merch',
  drop_off: 'Drop-off',
  parties: 'Parties',
  addons: 'Add-ons',
  stored_value: 'Stored value (no tax at load)',
};
