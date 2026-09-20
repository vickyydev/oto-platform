import { Link, useParams, useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Pencil, Trash2, ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { DataAdminLayout } from "./layout";
import { formatFieldValue, formatDate, humanise } from "./field-renderer";
import type { ModelMeta } from "./types";

export default function ModelDetailPage() {
  const params = useParams<{ model: string; id: string }>();
  const { model: modelSlug, id } = params;
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const { data: models = [] } = useQuery<ModelMeta[]>({
    queryKey: ["/api/data-admin/models"],
  });
  const model = models.find((m) => m.slug === modelSlug);

  const { data: row, isLoading } = useQuery<Record<string, unknown>>({
    queryKey: [`/api/data-admin/${modelSlug}/${id}`],
    queryFn: async () => {
      const res = await fetch(`/api/data-admin/${modelSlug}/${id}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Not found");
      return res.json();
    },
    enabled: !!id,
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      await apiRequest("DELETE", `/api/data-admin/${modelSlug}/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/data-admin/models"] });
      queryClient.invalidateQueries({ queryKey: [`/api/data-admin/${modelSlug}`] });
      toast({ title: `${model?.name ?? "Record"} deleted` });
      navigate(`/data/${modelSlug}`);
    },
    onError: (err: any) => {
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
    },
  });

  // Collect all fields (listDisplay + extra formFields) deduplicated
  const allFields = model
    ? [
        ...model.listDisplay,
        ...model.formFields.filter(
          (f) => !model.listDisplay.some((d) => d.key === f.key),
        ),
      ]
    : [];

  return (
    <DataAdminLayout>
      {/* Back link */}
      <Link href={`/data/${modelSlug}`}>
        <Button variant="ghost" size="sm" className="mb-4 -ml-2 text-muted-foreground">
          <ChevronLeft className="h-4 w-4 mr-1" />
          {model?.plural ?? modelSlug}
        </Button>
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">
            {isLoading ? (
              <Skeleton className="h-7 w-48" />
            ) : (
              (row?.name as string) ??
              (row?.fullName as string) ??
              (row?.slug as string) ??
              id
            )}
          </h1>
          <p className="text-xs text-muted-foreground mt-1">
            {model?.name} · {id}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href={`/data/${modelSlug}/${id}/edit`}>
            <Button size="sm" variant="outline">
              <Pencil className="h-3.5 w-3.5 mr-1.5" />
              Edit
            </Button>
          </Link>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button size="sm" variant="destructive">
                <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                Delete
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete this {model?.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  This action cannot be undone. The record will be permanently removed from
                  the database.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => deleteMutation.mutate()}
                  disabled={deleteMutation.isPending}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  {deleteMutation.isPending ? "Deleting…" : "Delete"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {/* Field table */}
      <div className="rounded-lg border border-border overflow-hidden max-w-3xl">
        {isLoading ? (
          <div className="divide-y divide-border">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="flex gap-6 px-5 py-3">
                <Skeleton className="h-4 w-28 flex-shrink-0" />
                <Skeleton className="h-4 w-48" />
              </div>
            ))}
          </div>
        ) : (
          <div className="divide-y divide-border">
            {allFields.map((field) => {
              const raw = row?.[field.key];
              const label = row?.[`${field.key}_label`] as string | undefined;

              return (
                <div key={field.key} className="flex items-start px-5 py-3 gap-6">
                  <dt className="w-36 flex-shrink-0 text-xs font-medium text-muted-foreground uppercase tracking-wide pt-0.5">
                    {field.label ?? humanise(field.key)}
                  </dt>
                  <dd className="flex-1 text-sm text-foreground">
                    {field.relatedModel && label !== undefined ? (
                      raw ? (
                        <Link href={`/data/${field.relatedModel}/${raw}`}>
                          <span className="text-primary hover:underline">
                            {label || String(raw)}
                          </span>
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )
                    ) : (
                      formatFieldValue(field, raw)
                    )}
                  </dd>
                </div>
              );
            })}

            {/* Always show timestamps if present */}
            {!!row?.createdAt && !allFields.some((f) => f.key === "createdAt") && (
              <div className="flex items-start px-5 py-3 gap-6">
                <dt className="w-36 flex-shrink-0 text-xs font-medium text-muted-foreground uppercase tracking-wide pt-0.5">
                  Created At
                </dt>
                <dd className="flex-1 text-sm text-muted-foreground">
                  {formatDate(row.createdAt as string)}
                </dd>
              </div>
            )}
            {!!row?.updatedAt && !allFields.some((f) => f.key === "updatedAt") && (
              <div className="flex items-start px-5 py-3 gap-6">
                <dt className="w-36 flex-shrink-0 text-xs font-medium text-muted-foreground uppercase tracking-wide pt-0.5">
                  Updated At
                </dt>
                <dd className="flex-1 text-sm text-muted-foreground">
                  {formatDate(row.updatedAt as string)}
                </dd>
              </div>
            )}
          </div>
        )}
      </div>
    </DataAdminLayout>
  );
}
