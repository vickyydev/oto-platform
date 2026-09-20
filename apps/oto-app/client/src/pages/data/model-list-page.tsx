import { useState, useEffect } from "react";
import { Link, useLocation, useParams } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Search, Plus, ChevronLeft, ChevronRight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { DataAdminLayout } from "./layout";
import type { ModelMeta, ListResult, FieldDef } from "./types";
import { formatFieldValue } from "./field-renderer";

const PAGE_SIZE = 25;

export default function ModelListPage() {
  const params = useParams<{ model: string }>();
  const modelSlug = params.model;

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [filters, setFilters] = useState<Record<string, string>>({});

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Reset page on filter/search change
  useEffect(() => { setPage(1); }, [debouncedSearch, filters]);

  const { data: models = [] } = useQuery<ModelMeta[]>({
    queryKey: ["/api/data-admin/models"],
  });
  const model = models.find((m) => m.slug === modelSlug);

  // Build query string
  const qs = new URLSearchParams();
  qs.set("page", String(page));
  qs.set("pageSize", String(PAGE_SIZE));
  if (debouncedSearch) qs.set("q", debouncedSearch);
  for (const [k, v] of Object.entries(filters)) {
    if (v) qs.set(k, v);
  }

  const { data: result, isLoading } = useQuery<ListResult>({
    queryKey: [`/api/data-admin/${modelSlug}`, page, debouncedSearch, filters],
    queryFn: async () => {
      const res = await fetch(`/api/data-admin/${modelSlug}?${qs}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch");
      return res.json();
    },
    enabled: !!model,
  });

  if (!model && models.length > 0) {
    return (
      <DataAdminLayout>
        <p className="text-muted-foreground">Model "{modelSlug}" not found.</p>
      </DataAdminLayout>
    );
  }

  const totalPages = result ? Math.ceil(result.total / PAGE_SIZE) : 1;

  return (
    <DataAdminLayout>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">
            {model?.plural ?? modelSlug}
          </h1>
          {model?.description && (
            <p className="text-sm text-muted-foreground mt-1">{model.description}</p>
          )}

        </div>
        <Link href={`/data/${modelSlug}/new`}>
          <Button size="sm">
            <Plus className="h-4 w-4 mr-1" />
            New {model?.name}
          </Button>
        </Link>
      </div>

      {/* Search + Filters */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        {model && model.searchFields.length > 0 && (
          <div className="relative w-64">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            <Input
              className="pl-8 h-8 text-sm"
              placeholder={`Search ${model.plural.toLowerCase()}…`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        )}

        {model?.filters.map((filter) => {
          const value = filters[filter.key] ?? "";

          if (filter.type === "boolean") {
            return (
              <Select
                key={filter.key}
                value={value}
                onValueChange={(v) =>
                  setFilters((prev) => ({ ...prev, [filter.key]: v === "__all__" ? "" : v }))
                }
              >
                <SelectTrigger className="h-8 text-sm w-36">
                  <SelectValue placeholder={filter.label ?? filter.key} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">All</SelectItem>
                  <SelectItem value="true">Yes</SelectItem>
                  <SelectItem value="false">No</SelectItem>
                </SelectContent>
              </Select>
            );
          }

          if (filter.type === "select" && filter.options && filter.options.length > 0) {
            return (
              <Select
                key={filter.key}
                value={value}
                onValueChange={(v) =>
                  setFilters((prev) => ({ ...prev, [filter.key]: v === "__all__" ? "" : v }))
                }
              >
                <SelectTrigger className="h-8 text-sm w-48">
                  <SelectValue placeholder={filter.label ?? filter.key} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">All</SelectItem>
                  {filter.options.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            );
          }

          return null;
        })}

        {/* Clear filters */}
        {(search || Object.values(filters).some(Boolean)) && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-xs text-muted-foreground"
            onClick={() => { setSearch(""); setFilters({}); }}
          >
            <X className="h-3 w-3 mr-1" />
            Clear
          </Button>
        )}
      </div>

      {/* Table */}
      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/50 border-b border-border">
              {model?.listDisplay.map((field) => (
                <th
                  key={field.key}
                  className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide whitespace-nowrap"
                >
                  {field.label ?? humanise(field.key)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              [...Array(8)].map((_, i) => (
                <tr key={i} className="border-b border-border last:border-0">
                  {(model?.listDisplay ?? [{}, {}, {}]).map((_, j) => (
                    <td key={j} className="px-4 py-2.5">
                      <Skeleton className="h-4 w-full" />
                    </td>
                  ))}
                </tr>
              ))
            ) : result?.rows.length === 0 ? (
              <tr>
                <td
                  colSpan={model?.listDisplay.length ?? 1}
                  className="px-4 py-12 text-center text-muted-foreground text-sm"
                >
                  No records found.
                </td>
              </tr>
            ) : (
              result?.rows.map((row, i) => (
                <tr
                  key={String(row.id ?? i)}
                  className="border-b border-border last:border-0 hover:bg-muted/30 cursor-pointer transition-colors"
                  onClick={() =>
                    (window.location.href = `/data/${modelSlug}/${row.id}`)
                  }
                >
                  {model?.listDisplay.map((field) => (
                    <td key={field.key} className="px-4 py-2.5 max-w-xs">
                      <CellValue field={field} row={row} modelSlug={modelSlug} />
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {result && (
        <div className="flex items-center justify-between mt-4 text-sm text-muted-foreground">
          <span>
            {result.total > PAGE_SIZE
              ? `${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, result.total)} of ${result.total.toLocaleString()}`
              : `${result.total.toLocaleString()} ${result.total === 1 ? model?.name : model?.plural}`}
          </span>
          {result.total > PAGE_SIZE && (
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="px-2">
                Page {page} of {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>
      )}
    </DataAdminLayout>
  );
}

// ── Cell renderer ─────────────────────────────────────────────────────────────

function CellValue({
  field,
  row,
  modelSlug,
}: {
  field: FieldDef;
  row: Record<string, unknown>;
  modelSlug: string;
}) {
  const raw = row[field.key];
  const label = row[`${field.key}_label`] as string | undefined;

  // FK field with resolved label
  if (field.relatedModel && label !== undefined) {
    if (!raw) return <span className="text-muted-foreground">—</span>;
    return (
      <Link
        href={`/data/${field.relatedModel}/${raw}`}
        onClick={(e) => e.stopPropagation()}
      >
        <span className="text-primary hover:underline">{label || String(raw)}</span>
      </Link>
    );
  }

  return <>{formatFieldValue(field, raw)}</>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function humanise(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (s) => s.toUpperCase())
    .trim();
}
