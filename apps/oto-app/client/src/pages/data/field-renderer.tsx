import { Badge } from "@/components/ui/badge";
import type { FieldDef } from "./types";

export function humanise(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (s) => s.toUpperCase())
    .trim();
}

export function formatDate(value: unknown): string {
  if (!value) return "—";
  try {
    return new Date(value as string).toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch {
    return String(value);
  }
}

/** Renders a field value as a React node for use in tables and detail views */
export function formatFieldValue(field: FieldDef, value: unknown): React.ReactNode {
  if (value === null || value === undefined || value === "") {
    return <span className="text-muted-foreground">—</span>;
  }

  if (field.type === "boolean") {
    return value ? (
      <Badge variant="default" className="bg-green-600/15 text-green-700 dark:bg-green-500/15 dark:text-green-400 border-0 font-medium text-xs">
        Yes
      </Badge>
    ) : (
      <Badge variant="secondary" className="font-medium text-xs">
        No
      </Badge>
    );
  }

  if (field.type === "date") {
    return <span className="text-muted-foreground">{formatDate(value)}</span>;
  }

  if (field.type === "enum") {
    const str = String(value);
    return (
      <Badge variant="outline" className="font-normal text-xs capitalize">
        {str.replace(/_/g, " ")}
      </Badge>
    );
  }

  if (field.type === "number") {
    return <span className="tabular-nums">{String(value)}</span>;
  }

  // Default: text, truncated
  const str = String(value);
  return <span className="truncate">{str}</span>;
}
