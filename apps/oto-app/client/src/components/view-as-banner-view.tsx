import { createElement } from "react";
import { Eye } from "lucide-react";
import { timeLeft, viewAsLine, type ViewAs } from "../lib/viewAsBanner";

/**
 * SCRUM-648 — the fixed, non-dismissible view-as banner (see lib/viewAsBanner.ts).
 * Written with createElement so the module-level checks render it under tsx
 * without a JSX runtime of their own.
 */
export function ViewAsBannerView({ viewAs, now }: { viewAs: ViewAs | null; now: number }) {
  if (!viewAs) return null;
  return createElement(
    "div",
    {
      role: "status",
      "aria-live": "polite",
      "data-testid": "impersonation-banner",
      className:
        "fixed inset-x-0 top-0 z-[60] flex h-9 items-center justify-center gap-2 overflow-hidden whitespace-nowrap border-b border-amber-500 bg-amber-400 px-4 text-sm font-semibold text-black",
    },
    createElement(Eye, { className: "h-4 w-4 shrink-0", "aria-hidden": "true" }),
    createElement("span", { className: "min-w-0 truncate" }, viewAsLine(viewAs)),
    createElement("span", { className: "shrink-0 tabular-nums" }, `\u00b7 ends in ${timeLeft(viewAs.expiresAt, now)}`),
  );
}
