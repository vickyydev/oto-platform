export interface ActivityMetricTotals {
  orders: number;
  revenue: number;
  ticketsSold: number;
}

export interface ActivityHourlyBucket extends ActivityMetricTotals {
  hour: number;
  label: string;
  summerCamp?: ActivityMetricTotals;
}

export interface ActivityDay {
  date: string;
  dayOfWeek?: string;
  hourly?: ActivityHourlyBucket[];
  hourlyBreakdown?: ActivityHourlyBucket[];
}

export type ActivityMetric = keyof ActivityMetricTotals;

export function getActivityHourlyTotals(
  days: ActivityDay[] = [],
  metric: ActivityMetric,
  hours: number[],
): Record<number, number> {
  const totals = Object.fromEntries(hours.map((hour) => [hour, 0])) as Record<number, number>;
  for (const day of days) {
    for (const bucket of day.hourly || day.hourlyBreakdown || []) {
      if (!(bucket.hour in totals)) continue;
      totals[bucket.hour] += bucket[metric] || 0;
    }
  }
  return totals;
}

function cloneBucket(bucket: ActivityHourlyBucket): ActivityHourlyBucket {
  if (!bucket.summerCamp) return { ...bucket };
  return { ...bucket, summerCamp: { ...bucket.summerCamp } };
}

export function mergeActivityHours(
  first: ActivityHourlyBucket[] = [],
  second: ActivityHourlyBucket[] = [],
): ActivityHourlyBucket[] {
  const byHour = new Map<number, ActivityHourlyBucket>();
  for (const bucket of [...first, ...second]) {
    const current = byHour.get(bucket.hour);
    if (!current) {
      byHour.set(bucket.hour, cloneBucket(bucket));
      continue;
    }
    current.orders += bucket.orders || 0;
    current.revenue += bucket.revenue || 0;
    current.ticketsSold += bucket.ticketsSold || 0;
    if (bucket.summerCamp) {
      current.summerCamp ||= { orders: 0, revenue: 0, ticketsSold: 0 };
      current.summerCamp.orders += bucket.summerCamp.orders || 0;
      current.summerCamp.revenue += bucket.summerCamp.revenue || 0;
      current.summerCamp.ticketsSold += bucket.summerCamp.ticketsSold || 0;
    }
  }
  return Array.from(byHour.values()).sort((a, b) => a.hour - b.hour);
}

export function mergeActivityDays(
  first: ActivityDay[] = [],
  second: ActivityDay[] = [],
): ActivityDay[] {
  const byDate = new Map<string, ActivityDay>();
  for (const day of [...first, ...second]) {
    const hours = day.hourly || day.hourlyBreakdown || [];
    const current = byDate.get(day.date);
    if (!current) {
      byDate.set(day.date, {
        ...day,
        hourly: undefined,
        hourlyBreakdown: hours.map(cloneBucket),
      });
      continue;
    }
    current.hourlyBreakdown = mergeActivityHours(
      current.hourlyBreakdown || current.hourly || [],
      hours,
    );
    current.hourly = undefined;
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

export function excludeSummerCamp(days: ActivityDay[] = []): ActivityDay[] {
  return days.map((day) => ({
    ...day,
    hourly: undefined,
    hourlyBreakdown: (day.hourly || day.hourlyBreakdown || []).map((bucket) => ({
      ...bucket,
      orders: Math.max(0, (bucket.orders || 0) - (bucket.summerCamp?.orders || 0)),
      revenue: Math.max(0, (bucket.revenue || 0) - (bucket.summerCamp?.revenue || 0)),
      ticketsSold: Math.max(0, (bucket.ticketsSold || 0) - (bucket.summerCamp?.ticketsSold || 0)),
    })),
  }));
}

export function excludeWeekends(days: ActivityDay[] = []): ActivityDay[] {
  return days.filter((day) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.date);
    if (!match) return true;
    const dayOfWeek = new Date(Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
    )).getUTCDay();
    return dayOfWeek !== 0 && dayOfWeek !== 6;
  });
}

export function fillActivityDateRange(
  days: ActivityDay[] = [],
  startDate: string,
  endDate: string,
): ActivityDay[] {
  const validDate = /^\d{4}-\d{2}-\d{2}$/;
  if (!validDate.test(startDate) || !validDate.test(endDate) || startDate > endDate) {
    return days;
  }

  const byDate = new Map(days.map((day) => [day.date, day]));
  const result: ActivityDay[] = [];
  const cursor = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  while (cursor <= end) {
    const date = cursor.toISOString().slice(0, 10);
    result.push(byDate.get(date) || {
      date,
      dayOfWeek: dayNames[cursor.getUTCDay()],
      hourlyBreakdown: [],
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return result;
}

export function getActivityBranchStatus(hasFloresta: boolean, hasChalong: boolean): string {
  if (hasFloresta && hasChalong) return "You are checking Chalong and Floresta combined";
  if (hasChalong) return "You are checking Chalong now";
  return "You are checking Floresta now";
}