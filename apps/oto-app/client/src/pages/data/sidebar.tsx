import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import type { ModelMeta } from "./types";

export function DataAdminSidebar() {
  const [location] = useLocation();
  const { data: models = [], isLoading } = useQuery<ModelMeta[]>({
    queryKey: ["/api/data-admin/models"],
  });

  if (isLoading) {
    return (
      <nav className="flex-1 overflow-y-auto py-2 px-2 space-y-0.5">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="h-8 rounded-md bg-sidebar-accent/40 animate-pulse" />
        ))}
      </nav>
    );
  }

  return (
    <nav className="flex-1 overflow-y-auto py-2 px-2 space-y-0.5">
      {models.map((model) => {
        const href = `/data/${model.slug}`;
        const isActive =
          location === href ||
          location.startsWith(`${href}/`);

        return (
          <Link key={model.slug} href={href}>
            <div
              className={cn(
                "flex items-center justify-between rounded-md px-3 py-2 text-sm cursor-pointer transition-colors",
                isActive
                  ? "bg-sidebar-primary text-sidebar-primary-foreground font-medium"
                  : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
              )}
            >
              <span>{model.plural}</span>
              {model.count !== undefined && (
                <span
                  className={cn(
                    "text-xs tabular-nums rounded-full px-1.5 py-0.5 min-w-[20px] text-center",
                    isActive
                      ? "bg-sidebar-primary-foreground/20 text-sidebar-primary-foreground"
                      : "bg-sidebar-accent text-muted-foreground",
                  )}
                >
                  {model.count}
                </span>
              )}
            </div>
          </Link>
        );
      })}
    </nav>
  );
}
