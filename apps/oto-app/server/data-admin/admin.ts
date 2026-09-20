import { db } from "../db";
import { count, eq, ilike, or, and, asc, desc, inArray, SQL, getTableColumns } from "drizzle-orm";

// ─── Field & form types ──────────────────────────────────────────────────────

export interface FieldDef {
  key: string;
  label?: string;
  /** How to render the value in list/detail views */
  type?: "text" | "boolean" | "date" | "number" | "enum";
  /** Slug of another registered ModelAdmin this FK points to */
  relatedModel?: string;
  /** Column on the related table to use as display label */
  relatedLabelField?: string;
}

export interface FormFieldDef extends FieldDef {
  required?: boolean;
  defaultValue?: unknown;
  /** For enum/select fields */
  options?: { label: string; value: string }[];
  /** Shown in form but not sent on submit (e.g. auto-generated fields) */
  readOnly?: boolean;
  /** HTML input type override */
  inputType?: "text" | "email" | "password" | "textarea" | "number";
}

export interface FilterDef {
  key: string;
  label?: string;
  type: "text" | "select" | "boolean";
  options?: { label: string; value: string }[];
}

// ─── Query param types ───────────────────────────────────────────────────────

export interface ListParams {
  page: number;
  pageSize: number;
  search?: string;
  filters?: Record<string, string>;
  orderBy?: string;
}

export interface ListResult {
  rows: Record<string, unknown>[];
  total: number;
  page: number;
  pageSize: number;
}

/** Serialisable metadata sent to the client so it can render without per-model code */
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
}

// ─── Pluralisation helper ────────────────────────────────────────────────────

function pluralize(name: string): string {
  const lower = name.toLowerCase();
  const vowels = new Set(["a", "e", "i", "o", "u"]);
  if (
    lower.endsWith("s") ||
    lower.endsWith("x") ||
    lower.endsWith("z") ||
    lower.endsWith("ch") ||
    lower.endsWith("sh")
  ) {
    return name + "es";
  }
  if (lower.endsWith("y") && !vowels.has(lower[lower.length - 2])) {
    return name.slice(0, -1) + "ies";
  }
  return name + "s";
}

// ─── Auto-derive form fields from Drizzle table columns ─────────────────────

const TEXTAREA_KEYS = /description|notes|address|body|text|html|reason|detail|summary|comment/i;
const DATE_TYPES = new Set(["PgTimestamp", "PgTimestampString", "PgDate"]);
const NUMBER_TYPES = new Set(["PgInteger", "PgReal", "PgNumeric", "PgSmallInt", "PgBigInt53", "PgBigInt64", "PgDoublePrecision"]);
const JSON_TYPES = new Set(["PgJsonb", "PgJson"]);
const ARRAY_TYPES = new Set(["PgArray"]);

export function deriveFormFields(table: any): FormFieldDef[] {
  const columns = getTableColumns(table) as Record<string, any>;
  return Object.entries(columns).map(([key, col]) => {
    const columnType: string = col.columnType ?? "";
    const isEnum = Array.isArray(col.enumValues) && col.enumValues.length > 0;
    const isBoolean = columnType === "PgBoolean";
    const isDate = DATE_TYPES.has(columnType);
    const isNumber = NUMBER_TYPES.has(columnType);
    const isJson = JSON_TYPES.has(columnType);
    const isArray = ARRAY_TYPES.has(columnType);
    const isPrimary = col.primary === true;
    const hasDefault = col.hasDefault === true;
    const notNull = col.notNull === true;

    const field: FormFieldDef = { key };

    // Required: notNull with no default and not the PK
    if (notNull && !hasDefault && !isPrimary) field.required = true;

    // Auto-managed fields: read-only in edit, hidden on create
    const AUTO_MANAGED = new Set(["createdAt", "updatedAt", "version"]);
    if (isPrimary || AUTO_MANAGED.has(key)) {
      field.readOnly = true;
      field.required = false;
    }

    // Type
    if (isBoolean) {
      field.type = "boolean";
    } else if (isDate) {
      field.type = "date";
    } else if (isNumber) {
      field.type = "number";
      field.inputType = "number";
    } else if (isEnum) {
      field.type = "enum";
      field.options = (col.enumValues as string[]).map((v) => ({
        label: v.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase()),
        value: v,
      }));
    } else if (isJson) {
      field.inputType = "textarea";
    } else if (isArray) {
      field.inputType = "textarea"; // raw array editing as JSON
    } else if (TEXTAREA_KEYS.test(key)) {
      field.inputType = "textarea";
    }

    // Password field
    if (key === "password") field.inputType = "password";

    return field;
  });
}

// ─── Base class ──────────────────────────────────────────────────────────────

export abstract class ModelAdmin {
  abstract name: string;
  /** The Drizzle table object, e.g. `branches` from @shared/schema */
  abstract table: any;
  /** Columns to show in the list view table */
  abstract listDisplay: FieldDef[];

  abstract description: string;
  abstract priority: number;
  searchFields: string[] = [];
  filters: FilterDef[] = [];
  defaultOrderBy: string = "createdAt";

  /**
   * Override in subclasses to customise the form.
   * Leave undefined to auto-derive all fields from the Drizzle table columns.
   */
  protected formFieldOverrides: FormFieldDef[] | undefined = undefined;

  get formFields(): FormFieldDef[] {
    if (this.formFieldOverrides !== undefined) return this.formFieldOverrides;
    return deriveFormFields(this.table);
  }

  get plural(): string {
    return pluralize(this.name);
  }

  get slug(): string {
    return this.plural.toLowerCase().replace(/\s+/g, "-");
  }

  get meta(): ModelMeta {
    return {
      name: this.name,
      plural: this.plural,
      slug: this.slug,
      description: this.description,
      priority: this.priority,
      listDisplay: this.listDisplay,
      searchFields: this.searchFields,
      filters: this.filters,
      formFields: this.formFields,
      defaultOrderBy: this.defaultOrderBy,
    };
  }

  // ── Private query helpers ─────────────────────────────────────────────────

  private buildWhere(params: ListParams): SQL | undefined {
    const conditions: SQL[] = [];

    if (params.search && this.searchFields.length > 0) {
      const clauses = this.searchFields
        .filter((f) => this.table[f])
        .map((f) => ilike(this.table[f], `%${params.search}%`));
      if (clauses.length > 0) conditions.push(or(...clauses)!);
    }

    if (params.filters) {
      for (const [key, value] of Object.entries(params.filters)) {
        if (value === undefined || value === null || value === "") continue;
        const col = this.table[key];
        if (!col) continue;
        if (value === "true") conditions.push(eq(col, true));
        else if (value === "false") conditions.push(eq(col, false));
        else conditions.push(eq(col, value));
      }
    }

    return conditions.length > 0 ? and(...conditions) : undefined;
  }

  private buildOrder(orderBy?: string): ReturnType<typeof asc> {
    let col = this.defaultOrderBy;
    let dir: "asc" | "desc" = "desc";
    if (orderBy) {
      if (orderBy.startsWith("-")) {
        col = orderBy.slice(1);
        dir = "desc";
      } else {
        col = orderBy;
        dir = "asc";
      }
    }
    const column = this.table[col] ?? this.table.id;
    return dir === "asc" ? asc(column) : desc(column);
  }

  // ── Public CRUD methods ───────────────────────────────────────────────────

  async getList(params: ListParams): Promise<ListResult> {
    const where = this.buildWhere(params);
    const offset = (params.page - 1) * params.pageSize;
    const order = this.buildOrder(params.orderBy);

    const [rows, totalResult] = await Promise.all([
      db.select().from(this.table).where(where).orderBy(order).limit(params.pageSize).offset(offset),
      db.select({ count: count() }).from(this.table).where(where),
    ]);

    return {
      rows,
      total: Number((totalResult as any)[0]?.count ?? 0),
      page: params.page,
      pageSize: params.pageSize,
    };
  }

  async getById(id: string): Promise<Record<string, unknown> | null> {
    const rows = await db.select().from(this.table).where(eq(this.table.id, id)).limit(1);
    return (rows[0] as Record<string, unknown>) ?? null;
  }

  async create(data: Record<string, unknown>): Promise<Record<string, unknown>> {
    const rows = (await db.insert(this.table).values(data as any).returning()) as any[];
    return rows[0] as Record<string, unknown>;
  }

  async update(id: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
    const rows = (await db.update(this.table).set(data as any).where(eq(this.table.id, id)).returning()) as any[];
    return rows[0] as Record<string, unknown>;
  }

  async delete(id: string): Promise<void> {
    await db.delete(this.table).where(eq(this.table.id, id));
  }

  /** Returns id+label pairs for use in FK dropdowns */
  async getOptions(labelField: string): Promise<{ id: string; label: string }[]> {
    const col = this.table[labelField];
    if (!col) return [];
    const rows = await db.select().from(this.table).orderBy(asc(col));
    return (rows as any[]).map((r) => ({ id: r.id, label: String(r[labelField] ?? "") }));
  }

  /**
   * For each FK field in `fields`, batch-fetch the related rows and attach
   * `${key}_label` to each row.  Used by list and detail endpoints.
   */
  async enrichRows(
    rows: Record<string, unknown>[],
    allAdmins: Map<string, ModelAdmin>,
    fields?: FieldDef[],
  ): Promise<Record<string, unknown>[]> {
    const fkFields = (fields ?? this.listDisplay).filter(
      (f) => f.relatedModel && f.relatedLabelField,
    );
    if (fkFields.length === 0) return rows;

    const enriched = rows.map((r) => ({ ...r }));

    for (const field of fkFields) {
      const relatedAdmin = allAdmins.get(field.relatedModel!);
      if (!relatedAdmin) continue;

      const ids = enriched.map((r) => r[field.key]).filter(Boolean) as string[];
      const uniqueIds = Array.from(new Set(ids));
      if (uniqueIds.length === 0) continue;

      const relatedRows = await db
        .select()
        .from(relatedAdmin.table)
        .where(inArray(relatedAdmin.table.id, uniqueIds));

      const labelMap = new Map(
        (relatedRows as any[]).map((r) => [r.id, r[field.relatedLabelField!]]),
      );

      for (const row of enriched) {
        if (row[field.key]) {
          row[`${field.key}_label`] = labelMap.get(row[field.key] as string) ?? null;
        }
      }
    }

    return enriched;
  }
}
