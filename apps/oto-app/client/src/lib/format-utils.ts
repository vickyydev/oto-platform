import { format as dateFnsFormat, parseISO, isValid } from "date-fns";

function parseDate(date: Date | string): Date | null {
  if (date instanceof Date) {
    return isValid(date) ? date : null;
  }
  
  if (!date || typeof date !== "string") return null;
  
  // Try parsing as ISO format first (most common from backend)
  try {
    const parsed = parseISO(date);
    if (isValid(parsed)) return parsed;
  } catch {}
  
  // Try parsing as yyyy-MM-dd format (date only)
  const dateOnlyMatch = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnlyMatch) {
    const d = new Date(parseInt(dateOnlyMatch[1]), parseInt(dateOnlyMatch[2]) - 1, parseInt(dateOnlyMatch[3]));
    if (isValid(d)) return d;
  }
  
  // Try parsing as dd-MM-yyyy format (our display format)
  const ddmmyyyyMatch = date.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (ddmmyyyyMatch) {
    const d = new Date(parseInt(ddmmyyyyMatch[3]), parseInt(ddmmyyyyMatch[2]) - 1, parseInt(ddmmyyyyMatch[1]));
    if (isValid(d)) return d;
  }
  
  // Fallback to Date constructor
  const fallback = new Date(date);
  return isValid(fallback) ? fallback : null;
}

export function formatDate(date: Date | string | null | undefined): string {
  if (!date) return "—";
  try {
    const dateObj = parseDate(date);
    if (!dateObj) return "—";
    return dateFnsFormat(dateObj, "dd-MM-yyyy");
  } catch {
    return "—";
  }
}

export function formatDateTime(date: Date | string | null | undefined): string {
  if (!date) return "—";
  try {
    const dateObj = parseDate(date);
    if (!dateObj) return "—";
    return dateFnsFormat(dateObj, "dd-MM-yyyy 'at' h:mm a");
  } catch {
    return "—";
  }
}

export function formatCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return value.toLocaleString("en-US");
}

export function parseCurrencyInput(value: string): number {
  const cleaned = value.replace(/,/g, "");
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

export function formatCurrencyInput(value: number | string): string {
  if (value === "" || value === null || value === undefined) return "";
  const num = typeof value === "string" ? parseCurrencyInput(value) : value;
  if (num === 0) return "";
  return num.toLocaleString("en-US");
}
