import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, Database } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { DataAdminLayout } from "./layout";
import type { ModelMeta } from "./types";

export default function DataAdminIndexPage() {
  const { data: models = [], isLoading } = useQuery<ModelMeta[]>({
    queryKey: ["/api/data-admin/models"],
  });

  return (
    <DataAdminLayout>
      <div className="max-w-4xl">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold text-foreground">Data Admin</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Browse, create, edit, and delete records across your database models.
          </p>
        </div>

        {isLoading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 items-stretch">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-28 rounded-lg" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 items-stretch">
            {models.map((model) => (
              <Link key={model.slug} href={`/data/${model.slug}`}>
                <Card className="cursor-pointer hover:border-primary/50 hover:shadow-sm transition-all group h-full flex flex-col">
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-2">
                        <Database className="h-4 w-4 text-muted-foreground" />
                        <CardTitle className="text-base font-medium">
                          {model.plural}
                        </CardTitle>
                      </div>
                      <ArrowRight className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
                    </div>
                    {model.description && (
                      <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{model.description}</p>
                    )}
                  </CardHeader>
                  <CardContent className="mt-auto">
                    <p className="text-3xl font-semibold text-foreground tabular-nums">
                      {model.count?.toLocaleString() ?? "—"}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {model.count === 1 ? model.name : model.plural} total
                    </p>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>
    </DataAdminLayout>
  );
}
