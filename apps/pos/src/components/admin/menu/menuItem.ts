export const formatPrice = (price: number) => `฿${price.toLocaleString()}`;

export const slugId = (name: string): string =>
  `m-${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')}-${Math.random().toString(36).slice(2, 7)}`;

export const randomId = (prefix: string) =>
  `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
