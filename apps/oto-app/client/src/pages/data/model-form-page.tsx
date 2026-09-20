import { useState, useEffect } from "react";
import { Link, useParams, useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { ChevronLeft, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { DataAdminLayout } from "./layout";
import { humanise } from "./field-renderer";
import type { ModelMeta, FormFieldDef, RelatedOption } from "./types";

// ─── Related (FK) select ──────────────────────────────────────────────────────

function RelatedSelect({
  field,
  value,
  onChange,
}: {
  field: FormFieldDef;
  value: string;
  onChange: (v: string) => void;
}) {
  const { data: options = [], isLoading } = useQuery<RelatedOption[]>({
    queryKey: [`/api/data-admin/${field.relatedModel}/options`, field.relatedLabelField],
    queryFn: async () => {
      const res = await fetch(
        `/api/data-admin/${field.relatedModel}/options?labelField=${field.relatedLabelField ?? "name"}`,
        { credentials: "include" },
      );
      if (!res.ok) throw new Error("Failed to load options");
      return res.json();
    },
    enabled: !!field.relatedModel,
  });

  if (isLoading) return <Skeleton className="h-9 w-full" />;

  return (
    <Select value={value || "__none__"} onValueChange={(v) => onChange(v === "__none__" ? "" : v)}>
      <SelectTrigger>
        <SelectValue placeholder={`Select ${field.label ?? humanise(field.key)}…`} />
      </SelectTrigger>
      <SelectContent>
        {!field.required && (
          <SelectItem value="__none__">— None —</SelectItem>
        )}
        {options.map((opt) => (
          <SelectItem key={opt.id} value={opt.id}>
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// ─── Single form field ────────────────────────────────────────────────────────

function FormField({
  field,
  value,
  onChange,
  isEdit,
}: {
  field: FormFieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
  isEdit: boolean;
}) {
  const strVal = value === null || value === undefined ? "" : String(value);

  // Read-only: render as plain text
  if (field.readOnly) {
    return (
      <p className="text-sm text-muted-foreground py-1.5 font-mono">
        {strVal || <span className="italic">—</span>}
      </p>
    );
  }

  // FK select
  if (field.relatedModel) {
    return (
      <RelatedSelect
        field={field}
        value={strVal}
        onChange={onChange}
      />
    );
  }

  // Options select (enum)
  if (field.options && field.options.length > 0) {
    return (
      <Select value={strVal} onValueChange={onChange}>
        <SelectTrigger>
          <SelectValue placeholder={`Select…`} />
        </SelectTrigger>
        <SelectContent>
          {field.options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  // Boolean toggle
  if (field.type === "boolean") {
    return (
      <Switch
        checked={Boolean(value)}
        onCheckedChange={onChange}
      />
    );
  }

  // Textarea
  if (field.inputType === "textarea") {
    return (
      <Textarea
        value={strVal}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        placeholder={field.label ?? humanise(field.key)}
      />
    );
  }

  // Number
  if (field.type === "number" || field.inputType === "number") {
    return (
      <Input
        type="number"
        value={strVal}
        onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
        placeholder="0"
      />
    );
  }

  // Password — hide field on edit unless user intends to change it
  if (field.inputType === "password") {
    return (
      <div className="space-y-1">
        <Input
          type="password"
          value={strVal}
          onChange={(e) => onChange(e.target.value)}
          placeholder={isEdit ? "Leave blank to keep current password" : "Enter password"}
          autoComplete="new-password"
        />
        {isEdit && (
          <p className="text-xs text-muted-foreground">
            Leave blank to keep the existing password.
          </p>
        )}
      </div>
    );
  }

  // Default text / email
  return (
    <Input
      type={field.inputType ?? "text"}
      value={strVal}
      onChange={(e) => onChange(e.target.value)}
      placeholder={field.label ?? humanise(field.key)}
    />
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function ModelFormPage() {
  const params = useParams<{ model: string; id?: string }>();
  const { model: modelSlug, id } = params;
  const isEdit = Boolean(id && id !== "new");
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const { data: models = [] } = useQuery<ModelMeta[]>({
    queryKey: ["/api/data-admin/models"],
  });
  const model = models.find((m) => m.slug === modelSlug);

  // Fetch existing record for edit mode
  const { data: existing, isLoading: loadingExisting } = useQuery<Record<string, unknown>>({
    queryKey: [`/api/data-admin/${modelSlug}/${id}`],
    queryFn: async () => {
      const res = await fetch(`/api/data-admin/${modelSlug}/${id}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Not found");
      return res.json();
    },
    enabled: isEdit && !!id,
  });

  // Form values keyed by field key
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [initialised, setInitialised] = useState(false);

  // Seed defaults on first load
  useEffect(() => {
    if (!model || initialised) return;

    if (isEdit && existing) {
      // Populate from existing record
      const seed: Record<string, unknown> = {};
      for (const f of model.formFields) {
        const v = existing[f.key];
        seed[f.key] = v !== undefined ? v : (f.defaultValue ?? "");
      }
      setValues(seed);
      setInitialised(true);
    } else if (!isEdit) {
      // Populate from defaults
      const seed: Record<string, unknown> = {};
      for (const f of model.formFields) {
        seed[f.key] = f.defaultValue ?? (f.type === "boolean" ? false : "");
      }
      setValues(seed);
      setInitialised(true);
    }
  }, [model, existing, isEdit, initialised]);

  const setValue = (key: string, val: unknown) =>
    setValues((prev) => ({ ...prev, [key]: val }));

  // Submit mutation
  const submitMutation = useMutation({
    mutationFn: async () => {
      // Coerce empty strings on non-required non-boolean fields to null.
      // Skip readOnly fields (e.g. auto-generated id, createdAt) on create so
      // the database default is used instead of sending null.
      const payload: Record<string, unknown> = {};
      for (const f of (model?.formFields ?? [])) {
        if (!isEdit && f.readOnly) continue;
        const v = values[f.key];
        if (f.type === "boolean") {
          payload[f.key] = Boolean(v);
        } else if (v === "" || v === undefined) {
          payload[f.key] = f.required ? v : null;
        } else {
          payload[f.key] = v;
        }
      }

      const url = isEdit
        ? `/api/data-admin/${modelSlug}/${id}`
        : `/api/data-admin/${modelSlug}`;
      const method = isEdit ? "PUT" : "POST";
      const res = await apiRequest(method, url, payload);
      return res.json();
    },
    onSuccess: (saved: Record<string, unknown>) => {
      queryClient.invalidateQueries({ queryKey: ["/api/data-admin/models"] });
      queryClient.invalidateQueries({ queryKey: [`/api/data-admin/${modelSlug}`] });
      if (isEdit) {
        queryClient.invalidateQueries({
          queryKey: [`/api/data-admin/${modelSlug}/${id}`],
        });
      }
      toast({
        title: isEdit
          ? `${model?.name} updated`
          : `${model?.name} created`,
      });
      navigate(`/data/${modelSlug}/${saved.id ?? id}`);
    },
    onError: (err: any) => {
      toast({
        title: isEdit ? "Update failed" : "Create failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const isLoading = isEdit && loadingExisting && !initialised;
  const formFields = model?.formFields ?? [];

  return (
    <DataAdminLayout>
      {/* Back link */}
      <Link href={isEdit ? `/data/${modelSlug}/${id}` : `/data/${modelSlug}`}>
        <Button variant="ghost" size="sm" className="mb-4 -ml-2 text-muted-foreground">
          <ChevronLeft className="h-4 w-4 mr-1" />
          {isEdit ? model?.name : model?.plural}
        </Button>
      </Link>

      <h1 className="text-2xl font-semibold text-foreground mb-6">
        {isEdit ? `Edit ${model?.name}` : `New ${model?.name}`}
      </h1>

      {isLoading ? (
        <div className="space-y-4 max-w-xl">
          {[...Array(5)].map((_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : (
        <form
          className="space-y-5 max-w-xl"
          onSubmit={(e) => {
            e.preventDefault();
            submitMutation.mutate();
          }}
        >
          {formFields.filter((field) => isEdit || !field.readOnly).map((field) =>
            field.type === "boolean" ? (
              <div key={field.key} className="flex items-center gap-3">
                <FormField
                  field={field}
                  value={values[field.key]}
                  onChange={(v) => setValue(field.key, v)}
                  isEdit={isEdit}
                />
                <Label htmlFor={field.key} className="text-sm font-medium cursor-pointer">
                  {field.label ?? humanise(field.key)}
                </Label>
              </div>
            ) : (
              <div key={field.key} className="space-y-1.5">
                <Label htmlFor={field.key} className="text-sm font-medium">
                  {field.label ?? humanise(field.key)}
                  {field.required && <span className="text-destructive ml-1">*</span>}
                </Label>
                <FormField
                  field={field}
                  value={values[field.key]}
                  onChange={(v) => setValue(field.key, v)}
                  isEdit={isEdit}
                />
              </div>
            )
          )}

          <div className="flex items-center gap-3 pt-2">
            <Button type="submit" disabled={submitMutation.isPending}>
              {submitMutation.isPending && (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              )}
              {isEdit ? "Save changes" : `Create ${model?.name}`}
            </Button>
            <Link href={isEdit ? `/data/${modelSlug}/${id}` : `/data/${modelSlug}`}>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </Link>
          </div>
        </form>
      )}
    </DataAdminLayout>
  );
}
