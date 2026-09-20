// Types mirroring data/admin.ts — kept here so Vite can import them without
// pulling in server-only dependencies.

export interface FieldDef {
  key: string;
  label?: string;
  type?: "text" | "boolean" | "date" | "number" | "enum";
  relatedModel?: string;
  relatedLabelField?: string;
}

export interface FormFieldDef extends FieldDef {
  required?: boolean;
  defaultValue?: unknown;
  options?: { label: string; value: string }[];
  readOnly?: boolean;
  inputType?: "text" | "email" | "password" | "textarea" | "number";
}

export interface FilterDef {
  key: string;
  label?: string;
  type: "text" | "select" | "boolean";
  options?: { label: string; value: string }[];
}

export interface ModelMeta {
  name: string;
  plural: string;
  slug: string;
  description: string;
  priority: number;
  listDisplay: FieldDef[];
  searchFields: string[];
  filters: FilterDef[];
  formFields: FormFieldDef[];
  defaultOrderBy: string;
  count?: number;
}

export interface ListResult {
  rows: Record<string, unknown>[];
  total: number;
  page: number;
  pageSize: number;
}

export interface RelatedOption {
  id: string;
  label: string;
}
