import { db } from '../db';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { currentTenant, rowScope, DataAdminScopeError } from './park-group';
import { branches, users, userBranchAccess } from '../../shared/schema';
import { getAdmin } from './registry';
import * as modelTables from '../../shared/schema';
import { count, eq, ilike, or, and, asc, desc, inArray, SQL, getTableColumns } from 'drizzle-orm';

// ─── Field & form types ──────────────────────────────────────────────────────

export interface FieldDef {
  key: string;
  label?: string;
  /** How to render the value in list/detail views */
  type?: 'text' | 'boolean' | 'date' | 'number' | 'enum';
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
  inputType?: 'text' | 'email' | 'password' | 'textarea' | 'number';
}

export interface FilterDef {
  key: string;
  label?: string;
  type: 'text' | 'select' | 'boolean';
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
  const vowels = new Set(['a', 'e', 'i', 'o', 'u']);
  if (
    lower.endsWith('s') ||
    lower.endsWith('x') ||
    lower.endsWith('z') ||
    lower.endsWith('ch') ||
    lower.endsWith('sh')
  ) {
    return name + 'es';
  }
  if (lower.endsWith('y') && !vowels.has(lower[lower.length - 2])) {
    return name.slice(0, -1) + 'ies';
  }
  return name + 's';
}

// ─── Auto-derive form fields from Drizzle table columns ─────────────────────

const TEXTAREA_KEYS = /description|notes|address|body|text|html|reason|detail|summary|comment/i;
const DATE_TYPES = new Set(['PgTimestamp', 'PgTimestampString', 'PgDate']);
const NUMBER_TYPES = new Set([
  'PgInteger',
  'PgReal',
  'PgNumeric',
  'PgSmallInt',
  'PgBigInt53',
  'PgBigInt64',
  'PgDoublePrecision',
]);
const JSON_TYPES = new Set(['PgJsonb', 'PgJson']);
const ARRAY_TYPES = new Set(['PgArray']);

export function deriveFormFields(table: any): FormFieldDef[] {
  const columns = getTableColumns(table) as Record<string, any>;
  return Object.entries(columns).map(([key, col]) => {
    const columnType: string = col.columnType ?? '';
    const isEnum = Array.isArray(col.enumValues) && col.enumValues.length > 0;
    const isBoolean = columnType === 'PgBoolean';
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
    const AUTO_MANAGED = new Set(['createdAt', 'updatedAt', 'version']);
    if (isPrimary || AUTO_MANAGED.has(key)) {
      field.readOnly = true;
      field.required = false;
    }

    // Type
    if (isBoolean) {
      field.type = 'boolean';
    } else if (isDate) {
      field.type = 'date';
    } else if (isNumber) {
      field.type = 'number';
      field.inputType = 'number';
    } else if (isEnum) {
      field.type = 'enum';
      field.options = (col.enumValues as string[]).map((v) => ({
        label: v.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()),
        value: v,
      }));
    } else if (isJson) {
      field.inputType = 'textarea';
    } else if (isArray) {
      field.inputType = 'textarea'; // raw array editing as JSON
    } else if (TEXTAREA_KEYS.test(key)) {
      field.inputType = 'textarea';
    }

    // Password field
    if (key === 'password') field.inputType = 'password';

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
  defaultOrderBy: string = 'createdAt';

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
    return this.plural.toLowerCase().replace(/\s+/g, '-');
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
    const conditions: SQL[] = [rowScope(this.table, currentTenant())];

    if (params.search && this.searchFields.length > 0) {
      const clauses = this.searchFields
        .filter((f) => this.table[f])
        .map((f) => ilike(this.table[f], `%${params.search}%`));
      if (clauses.length > 0) conditions.push(or(...clauses)!);
    }

    if (params.filters) {
      for (const [key, value] of Object.entries(params.filters)) {
        if (value === undefined || value === null || value === '') continue;
        const col = this.table[key];
        if (!col) continue;
        if (value === 'true') conditions.push(eq(col, true));
        else if (value === 'false') conditions.push(eq(col, false));
        else conditions.push(eq(col, value));
      }
    }

    return conditions.length > 0 ? and(...conditions) : undefined;
  }

  private buildOrder(orderBy?: string): ReturnType<typeof asc> {
    let col = this.defaultOrderBy;
    let dir: 'asc' | 'desc' = 'desc';
    if (orderBy) {
      if (orderBy.startsWith('-')) {
        col = orderBy.slice(1);
        dir = 'desc';
      } else {
        col = orderBy;
        dir = 'asc';
      }
    }
    const column = this.table[col] ?? this.table.id;
    return dir === 'asc' ? asc(column) : desc(column);
  }

  // ── Public CRUD methods ───────────────────────────────────────────────────

  /** Tenant fields stay put and supplied parents resolve in this park group. */
  private async scopedWrite(
    data: Record<string, unknown>,
    current?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const tenantId = currentTenant();
    const columns = getTableColumns(this.table) as Record<string, any>;
    const config = getTableConfig(this.table);
    const mutable = { ...data };
    delete mutable.id;
    const managedLinks: Record<string, string[]> = {
      branches: ['coreBranchId'],
      users: ['platformUserId'],
    };
    for (const key of managedLinks[config.name] ?? []) {
      if (key in mutable && (mutable[key] ?? null) !== (current?.[key] ?? null))
        throw new DataAdminScopeError(409, 'Manage this platform link through the platform screen');
    }
    if (this.table === users) delete mutable.platformUserId;
    const privateReferences: Record<string, string[]> = {
      contract_instances: ['pdfPath', 'signedPdfPath'],
      employee_letters: ['signedPdfPath'],
      employee_documents: ['filePath'],
      employees: ['profilePhotoPath', 'resignationFormPath', 'terminationLetterPath'],
      users: ['profilePhotoPath'],
      files: ['storageKey'],
    };
    for (const key of privateReferences[config.name] ?? []) {
      if (!(key in mutable) || !mutable[key] || mutable[key] === current?.[key]) continue;
      // Public external profile links retain their existing use; private object references use their module writer.
      if (key === 'profilePhotoPath' && typeof mutable[key] === 'string') {
        try {
          const url = new URL(mutable[key] as string);
          if (
            ['http:', 'https:'].includes(url.protocol) &&
            !/\/(?:api|uploads|objects|contracts|letters)(?:\/|$)/i.test(url.pathname)
          )
            continue;
        } catch {
          /* Stored private paths are handled below. */
        }
      }
      throw new DataAdminScopeError(
        409,
        'Use the document upload, photo or generation screen to attach this private file',
      );
    }
    const finance = [
      'xero_sync_runs',
      'xero_tracking_categories',
      'xero_tracking_options',
      'xero_reports_raw',
      'pl_facts',
      'cash_txns',
      'cash_daily',
    ].includes(config.name);
    if (config.name === 'roles') {
      const { tenants } = await import('../../shared/schema');
      const [sharedGroup] = await db
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.slug, 'default'))
        .limit(1);
      const target = mutable.tenantId ?? current?.tenantId ?? tenantId;
      if (target !== tenantId && target !== sharedGroup?.id)
        throw new DataAdminScopeError(404, 'Record not found');
      if (current && target !== current.tenantId)
        throw new DataAdminScopeError(409, 'The role stays with its park group');
      mutable.tenantId = target;
    } else if (columns.tenantId && !finance) {
      if (mutable.tenantId !== undefined && mutable.tenantId !== tenantId)
        throw new DataAdminScopeError(404, 'Record not found');
      mutable.tenantId = tenantId;
    }
    if (finance) {
      const target = mutable.tenantId ?? current?.tenantId;
      if (current && mutable.tenantId !== undefined && mutable.tenantId !== current.tenantId)
        throw new DataAdminScopeError(
          409,
          'The finance record stays with its connected organisation',
        );
      const { xeroTokens } = await import('../../shared/schema');
      const linked = await db
        .select()
        .from(xeroTokens)
        .where(eq(xeroTokens.xeroTenantId, target as string));
      if (!linked.length || linked.some((row) => row.tenantId !== tenantId))
        throw new DataAdminScopeError(404, 'Record not found');
    }
    const softParents: Record<string, Record<string, any>> = {
      access_policies: { coreUserId: modelTables.users },
      activity_log: {
        attentionItemId: modelTables.attentionItems,
        templateId: modelTables.templates,
      },
      employees: { primaryDepartmentId: modelTables.departments },
      people: { departmentId: modelTables.departments },
      schedule_audit_log: {
        weekPlanId: modelTables.scheduleWeekPlans,
        branchId: modelTables.branches,
      },
      templates: { forkedFromTemplateId: modelTables.templates },
      users: { createdBy: modelTables.users },
      schedule_shift_breaks: { createdBy: modelTables.users },
      timekeeping_issues: { createdBy: modelTables.users },
    };
    for (const [key, table] of Object.entries(softParents[config.name] ?? {})) {
      const value =
        key in mutable
          ? mutable[key]
          : config.name === 'access_policies'
            ? current?.[key]
            : undefined;
      if (value === undefined || value === null || value === '') continue;
      if (typeof value !== 'string')
        throw new DataAdminScopeError(400, 'Related record ID must be text');
      const [parent] = await db
        .select()
        .from(table)
        .where(and(eq(table.id, value), rowScope(table, tenantId, true)))
        .limit(1);
      if (!parent) throw new DataAdminScopeError(404, 'Related record not found');
    }
    for (const fk of config.foreignKeys) {
      const ref = fk.reference();
      if (ref.columns.length !== 1 || ref.columns[0].name === 'tenant_id') continue;
      const key = Object.keys(columns).find((k) => columns[k] === ref.columns[0]);
      if (!key || !(key in mutable) || mutable[key] === null || mutable[key] === '') continue;
      const [parent] = await db
        .select()
        .from(ref.foreignTable)
        .where(
          and(
            eq(ref.foreignColumns[0], mutable[key] as string),
            rowScope(ref.foreignTable, tenantId, true),
          ),
        )
        .limit(1);
      if (!parent) throw new DataAdminScopeError(404, 'Related record not found');
    }
    for (const field of this.formFields) {
      if (field.key === 'tenantId') continue;
      if (
        !field.relatedModel ||
        !(field.key in mutable) ||
        mutable[field.key] === null ||
        mutable[field.key] === ''
      )
        continue;
      const parentAdmin = getAdmin(field.relatedModel);
      if (!parentAdmin) continue;
      const [parent] = await db
        .select()
        .from(parentAdmin.table)
        .where(
          and(
            eq(parentAdmin.table.id, mutable[field.key] as string),
            rowScope(parentAdmin.table, tenantId, true),
          ),
        )
        .limit(1);
      if (!parent) throw new DataAdminScopeError(404, 'Related record not found');
    }
    if (config.name === 'people' && typeof mutable.email === 'string') {
      const logins = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, mutable.email));
      for (const login of logins) {
        const [own] = await db
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.id, login.id), rowScope(users, tenantId)))
          .limit(1);
        if (!own) throw new DataAdminScopeError(404, 'Related record not found');
      }
    }
    if ('branchIds' in mutable && mutable.branchIds !== null) {
      if (
        !Array.isArray(mutable.branchIds) ||
        mutable.branchIds.some((id) => typeof id !== 'string')
      ) {
        throw new DataAdminScopeError(400, 'branchIds must be a list of branch IDs');
      }
      const ids = mutable.branchIds as string[];
      const allowed = ids.length
        ? await db
            .select({ id: branches.id })
            .from(branches)
            .where(and(inArray(branches.id, ids), eq(branches.tenantId, tenantId)))
        : [];
      if (new Set(ids).size !== allowed.length)
        throw new DataAdminScopeError(404, 'Related record not found');
    }
    if (!columns.tenantId && !['people', 'users', 'tenants'].includes(config.name))
      rowScope(this.table, tenantId);
    return mutable;
  }

  async getList(params: ListParams): Promise<ListResult> {
    const where = this.buildWhere(params);
    const offset = (params.page - 1) * params.pageSize;
    const order = this.buildOrder(params.orderBy);

    const [rows, totalResult] = await Promise.all([
      db
        .select()
        .from(this.table)
        .where(where)
        .orderBy(order)
        .limit(params.pageSize)
        .offset(offset),
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
    const rows = await db
      .select()
      .from(this.table)
      .where(
        and(eq(this.table.id ?? this.table.employeeId, id), rowScope(this.table, currentTenant())),
      )
      .limit(1);
    return (rows[0] as Record<string, unknown>) ?? null;
  }

  async create(data: Record<string, unknown>): Promise<Record<string, unknown>> {
    const safeData = await this.scopedWrite(data);
    if (this.table === users) {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .insert(users)
          .values(safeData as any)
          .returning();
        // Empty selected access records ownership without adding a branch grant.
        await tx.insert(userBranchAccess).values({
          userId: row.id,
          tenantId: currentTenant(),
          accessScope: 'selected_branches',
          branchId: null,
        });
        return row;
      });
    }
    const rows = (await db
      .insert(this.table)
      .values(safeData as any)
      .returning()) as any[];
    return rows[0] as Record<string, unknown>;
  }

  async update(id: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
    const current = await this.getById(id);
    if (!current) throw new DataAdminScopeError(404, 'Record not found');
    const safeData = await this.scopedWrite(data, current);
    const rows = (await db
      .update(this.table)
      .set(safeData as any)
      .where(
        and(eq(this.table.id ?? this.table.employeeId, id), rowScope(this.table, currentTenant())),
      )
      .returning()) as any[];
    return rows[0] as Record<string, unknown>;
  }

  async delete(id: string): Promise<void> {
    const current = await this.getById(id);
    if (!current) throw new DataAdminScopeError(404, 'Record not found');
    if (this.table === users && current.platformUserId)
      throw new DataAdminScopeError(
        409,
        'This user is linked to the platform and cannot be deleted here',
      );
    await db
      .delete(this.table)
      .where(
        and(eq(this.table.id ?? this.table.employeeId, id), rowScope(this.table, currentTenant())),
      );
  }

  /** Returns id+label pairs for use in FK dropdowns */
  async getOptions(labelField: string): Promise<{ id: string; label: string }[]> {
    if (/password|secret|token|hash|fingerprint|claim|pin/i.test(labelField)) return [];
    const col = this.table[labelField];
    if (!col) return [];
    const rows = await db
      .select()
      .from(this.table)
      .where(rowScope(this.table, currentTenant(), true))
      .orderBy(asc(col));
    return (rows as any[]).map((r) => ({ id: r.id, label: String(r[labelField] ?? '') }));
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
        .where(
          and(
            inArray(relatedAdmin.table.id, uniqueIds),
            rowScope(relatedAdmin.table, currentTenant(), true),
          ),
        );

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
