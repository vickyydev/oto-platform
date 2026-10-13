type CountByCustomerType = Record<string, { kids: number; adults: number }>;

export interface RangeHourlyBucket {
  hour: number;
  label: string;
  orders: number;
  revenue: number;
  ticketsSold: number;
  categories?: Record<string, number>;
  customerTypes?: CountByCustomerType;
  summerCamp?: { orders: number; revenue: number; ticketsSold: number };
}

function emptyHour(hour: number): RangeHourlyBucket {
  return {
    hour,
    label: `${hour.toString().padStart(2, "0")}:00`,
    orders: 0,
    revenue: 0,
    ticketsSold: 0,
    categories: {},
    customerTypes: {},
  };
}

export function compactHourlyBuckets(
  buckets: RangeHourlyBucket[] | undefined,
): RangeHourlyBucket[] {
  if (!buckets?.length) return [];
  const usesTwentyMinuteSlots = buckets.length > 24 || buckets.some((bucket) => bucket.hour > 23);
  if (!usesTwentyMinuteSlots) return buckets;

  const hours = Array.from({ length: 24 }, (_, hour) => emptyHour(hour));
  for (const source of buckets) {
    const hour = Math.floor(source.hour / 3);
    if (hour < 0 || hour > 23) continue;
    const target = hours[hour];
    target.orders += source.orders || 0;
    target.revenue += source.revenue || 0;
    target.ticketsSold += source.ticketsSold || 0;
    for (const [category, revenue] of Object.entries(source.categories || {})) {
      target.categories![category] = (target.categories![category] || 0) + revenue;
    }
    for (const [type, counts] of Object.entries(source.customerTypes || {})) {
      const current = target.customerTypes![type] || { kids: 0, adults: 0 };
      current.kids += counts.kids || 0;
      current.adults += counts.adults || 0;
      target.customerTypes![type] = current;
    }
    if (source.summerCamp) {
      const current = target.summerCamp || { orders: 0, revenue: 0, ticketsSold: 0 };
      current.orders += source.summerCamp.orders || 0;
      current.revenue += source.summerCamp.revenue || 0;
      current.ticketsSold += source.summerCamp.ticketsSold || 0;
      target.summerCamp = current;
    }
  }
  return hours;
}

export function compactDashboardRange<T extends {
  hourlyBreakdown?: RangeHourlyBucket[];
  dailyHourly?: Array<{ date: string; hourlyBreakdown: RangeHourlyBucket[] }>;
}>(data: T): T {
  return {
    ...data,
    hourlyBreakdown: compactHourlyBuckets(data.hourlyBreakdown),
    dailyHourly: data.dailyHourly?.map((day) => ({
      ...day,
      hourlyBreakdown: compactHourlyBuckets(day.hourlyBreakdown),
    })),
  };
}

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

export class BoundedAsyncCache<T> {
  private readonly values = new Map<string, CacheEntry<T>>();
  private readonly pending = new Map<string, Promise<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): T | undefined {
    const cached = this.values.get(key);
    if (!cached) return undefined;
    if (cached.expiresAt <= this.now()) {
      this.values.delete(key);
      return undefined;
    }
    this.values.delete(key);
    this.values.set(key, cached);
    return cached.value;
  }

  set(key: string, value: T): void {
    this.values.set(key, { value, expiresAt: this.now() + this.ttlMs });
    while (this.values.size > this.maxEntries) {
      const oldest = this.values.keys().next().value;
      if (oldest === undefined) break;
      this.values.delete(oldest);
    }
  }

  async getOrLoad(key: string, loader: () => Promise<T>): Promise<T> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;

    const running = this.pending.get(key);
    if (running) return running;

    const request = loader()
      .then((value) => {
        this.set(key, value);
        return value;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, request);
    return request;
  }

  clear(): void {
    this.values.clear();
  }
}