export interface DashboardDateRange {
  from: Date;
  to: Date;
}

export function normalizeDashboardDateRange(from: Date, to: Date): DashboardDateRange {
  const first = new Date(from);
  const second = new Date(to);
  return first.getTime() <= second.getTime()
    ? { from: first, to: second }
    : { from: second, to: first };
}