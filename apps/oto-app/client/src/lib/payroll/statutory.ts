import { useQuery } from "@tanstack/react-query";
import type { EwfSurchargeView, StatutoryView } from "@shared/payroll-statutory";
import { payrollCall } from "@/lib/payroll/api";

/** The statutory documents page (SCRUM-571, R6): offers, coverage, documents and filings for one branch and period. */
export const useStatutory = (branchId: string, period: string) => useQuery<StatutoryView>({
  queryKey: ["/api/payroll/statutory", branchId, period],
  queryFn: () => payrollCall("GET", `/api/payroll/statutory?${new URLSearchParams({ ...(branchId ? { branchId } : {}), period })}`),
  staleTime: 0,
});

export const statutoryFileUrl = (documentId: string, index: number, download = false) =>
  `/api/payroll/statutory/documents/${documentId}/files/${index}${download ? "?download=1" : ""}`;

export const estimateEwfSurcharge = (dueDate: string, asOfDate: string, principal: string) =>
  payrollCall<EwfSurchargeView>("GET", `/api/payroll/statutory/ewf-surcharge?${new URLSearchParams({ dueDate, asOfDate, principal })}`);
