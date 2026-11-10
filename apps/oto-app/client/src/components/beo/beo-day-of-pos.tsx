import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, Gift } from "lucide-react";
import { bahtOfSatang, tillFiguresOf, type TillBillingReading } from "@shared/tillBilling";
import { TillBreakdown, TillMoneyRows } from "./beo-till-billing";

/** Party Details as the BEO keeps it: the app's own descriptive lines, in baht where it has prices. */
export interface DayOfPartyDetails {
  packageName?: string;
  packageBasePrice?: number;
  items?: Array<{ id: string; description: string; type: "included" | "extra"; price: number; notes: string }>;
  prepaymentReceived?: number;
  depositDate?: string;
  notes?: string;
}

/**
 * THE DAY-OF VIEW'S POS SECTION (SCRUM-822, fixing SCRUM-833).
 *
 * Its money is the till's, as the Billing section's and the Party Details
 * box's is (shared/tillBilling.ts): the header's figure is what the party
 * comes to, the rows are Expected total, Deposit paid and Outstanding (Total,
 * Paid, Outstanding once settled), and the breakdown is the till's lines. It
 * used to work a "Total" out of whatever it found first — the billing's
 * package price, else the package snapshot's base price, which is SATANG,
 * shown as baht (฿1,690,000 for a ฿16,900 package: SCRUM-833) — and take the
 * Party Details deposit from it. Now no figure here is the app's own: when
 * the till cannot be reached the section says "Till not reachable", and for an
 * event the till never settles, "Not settled at the till".
 *
 * Party Details' own included and extra lines stay as the staff wrote them.
 */
export function DayOfPosSection({
  packageName,
  partyDetails,
  posOrderRef,
  hasPosData,
  reading,
  loading,
  expanded,
  onToggle,
  doneToggle,
}: {
  packageName: string | null;
  partyDetails: DayOfPartyDetails | null;
  posOrderRef: string | null;
  /** Whether the BEO holds anything for the POS (a package, line items, Party Details). */
  hasPosData: boolean;
  reading: TillBillingReading | undefined;
  loading?: boolean;
  expanded: boolean;
  onToggle: () => void;
  doneToggle?: ReactNode;
}) {
  const figures = tillFiguresOf(reading);
  if (!hasPosData && !figures) return null;
  const items = partyDetails?.items || [];
  const includedItems = items.filter((item) => item.type === "included");
  const extraItems = items.filter((item) => item.type === "extra");
  const shownPackage = packageName || figures?.packageName || null;
  return (
    <div className="rounded-lg border border-border/50 bg-card overflow-hidden" style={{ borderLeft: "4px solid #7c3aed" }} data-testid="section-pos">
      <div
        role="button"
        tabIndex={0}
        className="w-full flex items-center justify-between p-3 text-left cursor-pointer"
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
        data-testid="button-toggle-pos"
      >
        <div className="flex items-center gap-2 min-w-0">
          <Gift className="h-5 w-5 text-purple-500 shrink-0" />
          <span className="font-semibold text-base shrink-0">POS</span>
          {figures ? (
            <Badge variant="outline" className="text-xs shrink-0" data-testid="text-pos-price">
              {bahtOfSatang(figures.expectedSatang)}
            </Badge>
          ) : reading?.status === "not_a_party" ? (
            <Badge variant="outline" className="text-xs shrink-0 text-muted-foreground" data-testid="text-pos-not-settled">
              not settled at the till
            </Badge>
          ) : reading && !loading ? (
            <Badge variant="outline" className="text-xs shrink-0 text-amber-600" data-testid="text-pos-till-unreachable">
              till not reachable
            </Badge>
          ) : null}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {doneToggle}
          <ChevronDown className={`h-5 w-5 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`} />
        </div>
      </div>
      {expanded && (
        <div className="px-3 pb-3 space-y-3" data-testid="content-pos">
          {shownPackage && (
            <div className="flex items-center justify-between">
              <Badge variant="outline" className="text-xs font-medium" data-testid="badge-pos-package">
                {shownPackage}
              </Badge>
              {figures && figures.packageSatang > 0 && (
                <span className="text-sm font-mono tabular-nums shrink-0 ml-2" data-testid="text-pos-package-price">
                  {bahtOfSatang(figures.packageSatang)}
                </span>
              )}
            </div>
          )}

          {items.length > 0 && (
            <div className="space-y-1" data-testid="list-pos-items">
              {includedItems.length > 0 && (
                <div className="space-y-0.5">
                  <span className="text-[10px] text-emerald-500 font-semibold uppercase tracking-wider">Included</span>
                  {includedItems.map((item, idx) => (
                    <div key={item.id || `incl-${idx}`} className="flex items-center gap-2 text-sm py-0.5 pl-1" data-testid={`row-pos-item-incl-${idx}`}>
                      <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
                      <span className="text-muted-foreground">{item.description}</span>
                    </div>
                  ))}
                </div>
              )}
              {extraItems.length > 0 && (
                <div className="space-y-0.5 pt-1">
                  <span className="text-[10px] text-amber-500 font-semibold uppercase tracking-wider">Extras</span>
                  {extraItems.map((item, idx) => (
                    <div key={item.id || `extra-${idx}`} className="flex items-center gap-2 text-sm py-0.5 pl-1" data-testid={`row-pos-item-extra-${idx}`}>
                      <div className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />
                      <span className="truncate">{item.description}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {figures && (
            <div className="border-t border-border/50 pt-2" data-testid="list-pos-till-lines">
              <span className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider">
                {figures.kind === "sale" ? `The till's sale${figures.receiptNumber ? ` · receipt ${figures.receiptNumber}` : ""}` : "The till's quote"}
              </span>
              <TillBreakdown figures={figures} />
            </div>
          )}

          <div className="border-t border-border/50 pt-2" data-testid="text-pos-money">
            <TillMoneyRows reading={reading} loading={loading} />
            {figures && partyDetails?.depositDate && figures.depositSatang > 0 && (
              <p className="text-xs text-muted-foreground pt-0.5">Deposit paid on {partyDetails.depositDate}</p>
            )}
          </div>

          {posOrderRef && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>POS Ref:</span>
              <span className="font-mono">{posOrderRef}</span>
            </div>
          )}

          {partyDetails?.notes && (
            <div className="text-xs text-muted-foreground italic border-t border-border/50 pt-2" data-testid="text-pos-notes">
              {partyDetails.notes}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
