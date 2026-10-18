import { useState } from "react";
import { format, startOfWeek, endOfWeek, startOfMonth, endOfMonth } from "date-fns";
import { Filter, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { DateRange } from "react-day-picker";

export type ChecklistFilters = {
  employeeId: string;
  departmentId: string;
  period: "none" | "day" | "week" | "month" | "custom";
  from: string;
  to: string;
};

export const emptyChecklistFilters: ChecklistFilters = {
  employeeId: "all", departmentId: "all", period: "none", from: "", to: "",
};

export function ChecklistFiltersControl({
  filters, onChange, employees, departments, allowDate,
}: {
  filters: ChecklistFilters;
  onChange: (filters: ChecklistFilters) => void;
  employees: { id: string; fullName: string; nickname?: string | null }[];
  departments: { id: string; name: string }[];
  allowDate: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [range, setRange] = useState<DateRange | undefined>();
  const active = Number(filters.employeeId !== "all") + Number(filters.departmentId !== "all") + Number(allowDate && filters.period !== "none");
  const setPeriod = (period: ChecklistFilters["period"]) => {
    if (period === "none") {
      onChange({ ...filters, period, from: "", to: "" });
    } else if (period === "custom") {
      onChange({ ...filters, period, from: "", to: "" });
      setRange(undefined);
    } else {
      const now = new Date();
      const from = period === "week" ? startOfWeek(now, { weekStartsOn: 1 }) : period === "month" ? startOfMonth(now) : now;
      const to = period === "week" ? endOfWeek(now, { weekStartsOn: 1 }) : period === "month" ? endOfMonth(now) : now;
      onChange({ ...filters, period, from: format(from, "yyyy-MM-dd"), to: format(to, "yyyy-MM-dd") });
    }
  };
  const label = filters.period === "none" ? "" : `${filters.period === "custom" ? "Custom" : filters.period[0].toUpperCase() + filters.period.slice(1)}: ${filters.from || "choose dates"}${filters.to && filters.to !== filters.from ? ` – ${filters.to}` : ""}`;
  return (
    <div className="flex flex-1 min-w-0 items-center gap-2 flex-wrap" data-testid="checklist-filters">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button size="sm" variant="outline" aria-label={`Filter checklists${active ? `, ${active} active` : ""}`} data-testid="button-checklist-filter">
            <Filter className="h-4 w-4 mr-2" />Filter{active ? ` (${active})` : ""}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[min(340px,calc(100vw-24px))] max-h-[min(80vh,650px)] overflow-y-auto space-y-3" data-testid="checklist-filter-panel">
          <div className="space-y-1">
            <label className="text-sm font-medium">Employee</label>
            <Select value={filters.employeeId} onValueChange={(employeeId) => onChange({ ...filters, employeeId })}>
              <SelectTrigger aria-label="Employee filter"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">All employees</SelectItem>{employees.map(e => <SelectItem key={e.id} value={e.id}>{e.nickname || e.fullName}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">Department</label>
            <Select value={filters.departmentId} onValueChange={(departmentId) => onChange({ ...filters, departmentId })}>
              <SelectTrigger aria-label="Department filter"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">All departments</SelectItem>{departments.map(d => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          {allowDate && <>
            <div className="space-y-1">
              <label className="text-sm font-medium">Time period</label>
              <Select value={filters.period} onValueChange={(value) => setPeriod(value as ChecklistFilters["period"])}>
                <SelectTrigger aria-label="Time period"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Any time</SelectItem>
                  <SelectItem value="day">Day</SelectItem>
                  <SelectItem value="week">Week (Mon–Sun)</SelectItem>
                  <SelectItem value="month">Month</SelectItem>
                  <SelectItem value="custom">Custom range</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {filters.period !== "none" && <div className="overflow-x-auto">
              {filters.period === "custom" ? (
                <Calendar mode="range" selected={range} onSelect={(selected) => {
                  setRange(selected);
                  onChange({ ...filters, from: selected?.from ? format(selected.from, "yyyy-MM-dd") : "", to: selected?.to ? format(selected.to, "yyyy-MM-dd") : "" });
                }} weekStartsOn={1} />
              ) : (
                <Calendar mode="single" selected={filters.from ? new Date(`${filters.from}T12:00:00`) : undefined}
                  onSelect={(date) => {
                    if (!date) return;
                    const from = filters.period === "week" ? startOfWeek(date, { weekStartsOn: 1 }) : filters.period === "month" ? startOfMonth(date) : date;
                    const to = filters.period === "week" ? endOfWeek(date, { weekStartsOn: 1 }) : filters.period === "month" ? endOfMonth(date) : date;
                    onChange({ ...filters, from: format(from, "yyyy-MM-dd"), to: format(to, "yyyy-MM-dd") });
                  }} weekStartsOn={1} />
              )}
            </div>}
            {filters.period === "custom" && (!filters.from || !filters.to) && <p className="text-xs text-muted-foreground">Choose both the first and last day.</p>}
          </>}
          {active > 0 && <Button size="sm" variant="ghost" onClick={() => { onChange(emptyChecklistFilters); setRange(undefined); }}>Clear all filters</Button>}
        </PopoverContent>
      </Popover>
      {filters.employeeId !== "all" && <Button size="sm" variant="secondary" onClick={() => onChange({ ...filters, employeeId: "all" })} aria-label="Remove employee filter">Employee: {employees.find(e => e.id === filters.employeeId)?.nickname || employees.find(e => e.id === filters.employeeId)?.fullName || "Selected"} <X className="h-3 w-3 ml-1" /></Button>}
      {filters.departmentId !== "all" && <Button size="sm" variant="secondary" onClick={() => onChange({ ...filters, departmentId: "all" })} aria-label="Remove department filter">Department: {departments.find(d => d.id === filters.departmentId)?.name || "Selected"} <X className="h-3 w-3 ml-1" /></Button>}
      {allowDate && filters.period !== "none" && <Button size="sm" variant="secondary" onClick={() => onChange({ ...filters, period: "none", from: "", to: "" })} aria-label="Remove time filter">{label} <X className="h-3 w-3 ml-1" /></Button>}
      {active > 1 && <Button size="sm" variant="ghost" onClick={() => { onChange(emptyChecklistFilters); setRange(undefined); }}>Clear all</Button>}
    </div>
  );
}