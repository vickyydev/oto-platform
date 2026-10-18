import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

export function DutyShiftMark({ className, decorative = false }: { className?: string; decorative?: boolean }) {
  return <span className={cn("inline-block shrink-0 align-middle text-[13px] font-black leading-none", className)} style={{ textShadow: "0 0 0.6px currentColor" }} title={decorative ? undefined : "Duty assigned"} aria-label={decorative ? undefined : "Duty assigned"} aria-hidden={decorative || undefined}>✴</span>;
}

export function DutyShiftTime({ children, hasDuty, compact = false }: { children: ReactNode; hasDuty: boolean; compact?: boolean }) {
  if (!hasDuty) return <>{children}</>;

  return (
    <span className={cn("inline-flex items-center justify-center gap-1 whitespace-nowrap align-middle", compact && "gap-0.5")} title="Duty assigned">
      <DutyShiftMark decorative className={compact ? "text-[10px]" : undefined} />
      <span>{children}</span>
      <DutyShiftMark decorative className={compact ? "text-[10px]" : undefined} />
      <span className="sr-only">Duty assigned</span>
    </span>
  );
}