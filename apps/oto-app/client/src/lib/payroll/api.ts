import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import type { PayrollProfileView, PayrollRosterView, PayrollSetupChange, PayrollSetupView } from "@shared/payroll-config";

/** A refused payroll call: the server's words plus the prototype's list of problems, when it gave one. */
export class PayrollApiError extends Error {
  constructor(message: string, public status: number, public errors: string[] = []) { super(message); }
}

export async function payrollCall<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method, credentials: "include",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new PayrollApiError(data.message || res.statusText, res.status, Array.isArray(data.errors) ? data.errors : []);
  return data as T;
}

export const SETUP_KEY = ["/api/payroll/setup"] as const;
export const ROSTER_KEY = ["/api/payroll/profiles"] as const;

export const usePayrollSetup = () => useQuery<PayrollSetupView>({
  queryKey: SETUP_KEY, queryFn: () => payrollCall("GET", "/api/payroll/setup"), staleTime: 0,
});
export const useSetupChanges = () => useQuery<PayrollSetupChange[]>({
  queryKey: ["/api/payroll/setup/changes"], queryFn: () => payrollCall("GET", "/api/payroll/setup/changes"), staleTime: 0,
});
export const usePayrollRoster = () => useQuery<PayrollRosterView>({
  queryKey: ROSTER_KEY, queryFn: () => payrollCall("GET", "/api/payroll/profiles"), staleTime: 0,
});
export const usePayrollProfile = (employeeId: string) => useQuery<PayrollProfileView>({
  queryKey: ["/api/payroll/profiles", employeeId],
  queryFn: () => payrollCall("GET", `/api/payroll/profiles/${encodeURIComponent(employeeId)}`), staleTime: 0,
});

export function refreshPayroll(): Promise<unknown> {
  return queryClient.invalidateQueries({ predicate: (query) => String(query.queryKey[0]).startsWith("/api/payroll/") });
}

export const errorText = (error: unknown) => error instanceof Error ? error.message : "Something went wrong.";
export const errorList = (error: unknown) => error instanceof PayrollApiError ? error.errors : [];

export const money = (value: number | null | undefined, currency = "THB") =>
  value == null ? "—" : `${currency === "THB" ? "฿" : `${currency} `}${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
