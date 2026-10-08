import pg from "pg";
import { pool as devPool } from "./db";
import type { Express, Request, Response } from "express";
import { DEPLOY_ENV } from "./config/env";
import { devOnly } from "./lib/routeFences";

const { Pool } = pg;

const TABLE_ORDER = [
  "tenants",
  "operators",
  "branches",
  "departments",
  "roles",
  "shift_groups",
  "duty_types",
  "locations",
  "people",
  "users",
  "employees",
  "department_branch_assignments",
  "role_branch_assignments",
  "role_department_map",
  "employee_roles",
  "employee_role_availability",
  "user_branch_access",
  "user_module_overrides",
  "location_branch_access",
  "settings",
  "templates",
  "template_assignments",
  "policy_documents",
  "contract_instances",
  "employee_documents",
  "employee_offboarding",
  "employee_letters",
  "employee_changes",
  "asset_catalog",
  "employee_assets",
  "offboarding_checklist",
  "employee_payroll_profiles",
  "employee_presence",
  "employee_time_off",
  "leave_policies",
  "sick_leave_policies",
  "public_holidays",
  "shifts",
  "shift_required_roles",
  "schedule_week_plans",
  "schedule_shift_rows",
  "schedule_shift_row_roles",
  "schedule_shift_breaks",
  "schedule_assignments",
  "schedule_audit_log",
  "coverage_rules",
  "schedule_templates",
  "schedule_template_rows",
  "schedule_template_row_roles",
  "schedule_template_assignments",
  "schedule_template_time_off",
  "duty_blocks",
  "casual_workers",
  "kiosk_devices",
  "time_events",
  "time_entries",
  "time_adjustments",
  "timekeeping_issues",
  "payroll_policy_settings",
  "statutory_rule_sets",
  "payroll_periods",
  "payroll_runs",
  "payroll_employee_summaries",
  "payroll_line_items",
  "payroll_day_reconciliations",
  "payroll_exceptions",
  "payroll_exception_approvals",
  "statutory_calculation_results",
  "payslips",
  "salary_advances",
  "salary_advance_repayments",
  "staff_cost_allocations",
  "activity_log",
  "attention_items",
  "core_events",
  "task_templates",
  "task_template_questions",
  "tasks",
  "task_activities",
  "task_comments",
  "task_completions",
  "task_questions",
  "task_assignments",
  "task_attachments",
  "task_checklist_items",
  "checklist_templates",
  "checklist_template_items",
  "checklist_runs",
  "checklist_run_items",
  "checklist_attachments",
  "issues",
  "escalations",
  "sop_articles",
  "kb_articles",
  "kb_article_versions",
  "knowledge_files",
  "knowledge_chunks",
  "training_modules",
  "quiz_attempts",
  "module_completions",
  "quiz_questions",
  "troubleshooting_flows",
  "troubleshooting_nodes",
  "ask_oto_threads",
  "ask_oto_messages",
  "beo_locations",
  "branch_events",
  "event_statuses",
  "event_line_item_templates",
  "event_line_items",
  "beo_timeline_items",
  "beo_setup_items",
  "beo_setup_item_options",
  "beo_setup_plans",
  "beo_kitchen_plans",
  "beo_entertainment_items",
  "beo_entertainment_options",
  "beo_entertainment_selections",
  "beo_entertainment_assignments",
  "beo_assignment_targets",
  "beo_party_host_assignments",
  "beo_event_billing",
  "beo_package_snapshot_items",
  "beo_package_snapshots",
  "birthday_package_templates",
  "entertainment_package_templates",
  "package_line_item_templates",
  "invitation_designs",
  "studio_event_details",
  "studio_event_form_schema",
  "studio_event_info_blocks",
  "studio_event_tasks",
  "studio_event_bookings",
  "rsvp_entries",
  "nanny_reservations",
  "service_checkins",
  "dropoff_forms",
  "dropoff_form_versions",
  "dropoff_checkins",
  "enrollment_sessions",
  "parent_portal_tokens",
  "parent_message_logs",
  "guest_invite_tokens",
  "kiosk_codes",
  "kiosk_sessions",
  "kiosk_auth_attempts",
  "org_nodes",
  "hiring_media_assets",
  "files",
  "voucher_templates",
  "user_vouchers",
  "voucher_redemptions",
  "access_policies",
  "access_items",
  "access_view_logs",
  "fix_reports",
  "fix_comments",
  "fix_supplier_tokens",
  "announcements",
  "notifications",
  "xero_tokens",
  "xero_sync_runs",
  "xero_tracking_categories",
  "xero_tracking_options",
  "xero_reports_raw",
  "pl_facts",
  "cash_txns",
  "cash_daily",
  "auth_otp_events",
  "auth_rate_limits",
  "auth_reset_tokens",
  "i18n_translations",
  "translation_jobs",
  "directory_cache",
];

const SKIP_TABLES = ["session"];

const CRITICAL_TABLES = [
  "people",
  "users",
  "employees",
  "beo_setup_plans",
  "beo_kitchen_plans",
  "task_assignments",
];

interface FailedRow {
  rowId: string;
  error: string;
}

interface TableSyncResult {
  table: string;
  prodCount: number;
  devCount: number;
  insertedRows: number;
  skippedRows: number;
  failedRows: FailedRow[];
}

interface SyncProgress {
  status: "idle" | "running" | "completed" | "error";
  currentTable: string;
  tablesCompleted: number;
  totalTables: number;
  rowsCopied: number;
  errors: string[];
  warnings: string[];
  tableSyncResults: TableSyncResult[];
  rowCountMismatches: { table: string; prodCount: number; devCount: number }[];
  startedAt: string | null;
  completedAt: string | null;
}

let syncProgress: SyncProgress = {
  status: "idle",
  currentTable: "",
  tablesCompleted: 0,
  totalTables: 0,
  rowsCopied: 0,
  errors: [],
  warnings: [],
  tableSyncResults: [],
  rowCountMismatches: [],
  startedAt: null,
  completedAt: null,
};

async function validateTableOrderAgainstFKs(pool: pg.Pool): Promise<string[]> {
  const fkResult = await pool.query(`
    SELECT
      tc.table_name AS child_table,
      ccu.table_name AS parent_table
    FROM information_schema.table_constraints tc
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name
      AND tc.table_schema = ccu.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
      AND tc.table_name <> ccu.table_name
  `);

  const tableIndex = new Map<string, number>();
  TABLE_ORDER.forEach((t, i) => tableIndex.set(t, i));

  const warnings: string[] = [];
  const seen = new Set<string>();

  for (const row of fkResult.rows) {
    const child = row.child_table;
    const parent = row.parent_table;
    const key = `${child}->${parent}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const childIdx = tableIndex.get(child);
    const parentIdx = tableIndex.get(parent);

    if (childIdx !== undefined && parentIdx !== undefined && childIdx < parentIdx) {
      warnings.push(
        `FK ordering issue: "${child}" (pos ${childIdx}) depends on "${parent}" (pos ${parentIdx}) but is listed first`
      );
    }
  }

  return warnings;
}

async function getAllProductionTables(prodPool: pg.Pool): Promise<string[]> {
  const result = await prodPool.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`
  );
  return result.rows.map((r: any) => r.table_name);
}

function getRowIdentifier(row: any): string {
  if (row.id !== undefined) return String(row.id);
  const keys = Object.keys(row);
  if (keys.length > 0) return `${keys[0]}=${row[keys[0]]}`;
  return "(unknown)";
}

function prepareValue(val: any, col: string, arrayColumns: Set<string>): any {
  if (val !== null && typeof val === "object" && !(val instanceof Date) && !arrayColumns.has(col)) {
    return JSON.stringify(val);
  }
  return val;
}

async function syncTable(prodPool: pg.Pool, tableName: string): Promise<TableSyncResult> {
  const prodClient = await prodPool.connect();
  const devClient = await devPool.connect();
  const MAX_FAILED_ROWS_LOGGED = 20;

  try {
    const { rows } = await prodClient.query(`SELECT * FROM "${tableName}"`);
    const prodCount = rows.length;

    if (rows.length === 0) {
      await devClient.query(`DELETE FROM "${tableName}"`);
      return { table: tableName, prodCount: 0, devCount: 0, insertedRows: 0, skippedRows: 0, failedRows: [] };
    }

    const columns = Object.keys(rows[0]);
    const quotedColumns = columns.map(c => `"${c}"`).join(", ");

    const colTypesResult = await prodClient.query(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
      [tableName]
    );
    const arrayColumns = new Set(
      colTypesResult.rows.filter((r: any) => r.data_type === "ARRAY").map((r: any) => r.column_name)
    );

    await devClient.query(`DELETE FROM "${tableName}"`);

    const BATCH_SIZE = 200;
    let totalInserted = 0;
    let totalSkipped = 0;
    const failedRows: FailedRow[] = [];

    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const valuePlaceholders: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;

      for (const row of batch) {
        const rowPlaceholders: string[] = [];
        for (const col of columns) {
          values.push(prepareValue(row[col], col, arrayColumns));
          rowPlaceholders.push(`$${paramIndex}`);
          paramIndex++;
        }
        valuePlaceholders.push(`(${rowPlaceholders.join(", ")})`);
      }

      const insertQuery = `INSERT INTO "${tableName}" (${quotedColumns}) VALUES ${valuePlaceholders.join(", ")}`;

      try {
        await devClient.query(insertQuery, values);
        totalInserted += batch.length;
      } catch (batchErr: any) {
        await devClient.query("BEGIN");
        let batchInserted = 0;
        let batchSkipped = 0;
        const batchFailedRows: FailedRow[] = [];
        try {
          for (const row of batch) {
            const rowValues = columns.map(col => prepareValue(row[col], col, arrayColumns));
            const rowPlaceholders = rowValues.map((_, idx) => `$${idx + 1}`).join(", ");
            const singleInsert = `INSERT INTO "${tableName}" (${quotedColumns}) VALUES (${rowPlaceholders})`;

            try {
              await devClient.query("SAVEPOINT row_insert");
              await devClient.query(singleInsert, rowValues);
              await devClient.query("RELEASE SAVEPOINT row_insert");
              batchInserted++;
            } catch (rowErr: any) {
              await devClient.query("ROLLBACK TO SAVEPOINT row_insert");
              batchSkipped++;
              if (failedRows.length + batchFailedRows.length < MAX_FAILED_ROWS_LOGGED) {
                batchFailedRows.push({
                  rowId: getRowIdentifier(row),
                  error: rowErr.message,
                });
              }
            }
          }
          await devClient.query("COMMIT");
          totalInserted += batchInserted;
          totalSkipped += batchSkipped;
          failedRows.push(...batchFailedRows);
        } catch (txErr: any) {
          await devClient.query("ROLLBACK");
          totalSkipped += batch.length;
          if (failedRows.length < MAX_FAILED_ROWS_LOGGED) {
            failedRows.push({
              rowId: `batch@${i}`,
              error: `Transaction failed: ${txErr.message}`,
            });
          }
        }
      }
    }

    const devCountResult = await devClient.query(`SELECT COUNT(*)::int as cnt FROM "${tableName}"`);
    const devCount = devCountResult.rows[0].cnt;

    return { table: tableName, prodCount, devCount, insertedRows: totalInserted, skippedRows: totalSkipped, failedRows };
  } finally {
    prodClient.release();
    devClient.release();
  }
}

async function runPostSyncValidation(prodPool: pg.Pool): Promise<{ table: string; prodCount: number; devCount: number }[]> {
  const mismatches: { table: string; prodCount: number; devCount: number }[] = [];

  for (const tableName of CRITICAL_TABLES) {
    try {
      const prodResult = await prodPool.query(`SELECT COUNT(*)::int as cnt FROM "${tableName}"`);
      const devResult = await devPool.query(`SELECT COUNT(*)::int as cnt FROM "${tableName}"`);
      const prodCount = prodResult.rows[0].cnt;
      const devCount = devResult.rows[0].cnt;

      if (prodCount !== devCount) {
        mismatches.push({ table: tableName, prodCount, devCount });
      }
    } catch (err: any) {
      mismatches.push({ table: tableName, prodCount: -1, devCount: -1 });
      syncProgress.warnings.push(`Validation error for ${tableName}: ${err.message}`);
    }
  }

  return mismatches;
}

async function runSync(prodDbUrl: string) {
  syncProgress = {
    status: "running",
    currentTable: "Connecting...",
    tablesCompleted: 0,
    totalTables: 0,
    rowsCopied: 0,
    errors: [],
    warnings: [],
    tableSyncResults: [],
    rowCountMismatches: [],
    startedAt: new Date().toISOString(),
    completedAt: null,
  };

  const prodPool = new Pool({
    connectionString: prodDbUrl,
    ssl: { rejectUnauthorized: false },
    max: 3,
  });

  try {
    await prodPool.query("SELECT 1");

    const fkOrderIssues = await validateTableOrderAgainstFKs(prodPool);
    if (fkOrderIssues.length > 0) {
      for (const issue of fkOrderIssues) {
        syncProgress.errors.push(issue);
      }
      syncProgress.status = "error";
      syncProgress.currentTable = "Aborted — FK ordering violation";
      syncProgress.completedAt = new Date().toISOString();
      return;
    }

    const allProdTables = await getAllProductionTables(prodPool);
    const orderedTables = TABLE_ORDER.filter(t => allProdTables.includes(t) && !SKIP_TABLES.includes(t));
    const remainingTables = allProdTables.filter(t => !orderedTables.includes(t) && !SKIP_TABLES.includes(t));
    const tablesToSync = [...orderedTables, ...remainingTables];

    syncProgress.totalTables = tablesToSync.length;

    const devClient = await devPool.connect();
    try {
      await devClient.query("SET session_replication_role = 'replica'");

      for (const tableName of [...tablesToSync].reverse()) {
        try {
          await devClient.query(`DELETE FROM "${tableName}"`);
        } catch (err: any) {
          syncProgress.errors.push(`Clear ${tableName}: ${err.message}`);
        }
      }

      await devClient.query("SET session_replication_role = 'origin'");
    } finally {
      devClient.release();
    }

    const devClient2 = await devPool.connect();
    try {
      await devClient2.query("SET session_replication_role = 'replica'");
    } finally {
      devClient2.release();
    }

    for (const tableName of tablesToSync) {
      syncProgress.currentTable = tableName;
      try {
        const result = await syncTable(prodPool, tableName);
        syncProgress.rowsCopied += result.insertedRows;
        syncProgress.tableSyncResults.push(result);

        if (result.failedRows.length > 0) {
          const failedSamples = result.failedRows
            .slice(0, 5)
            .map(f => `  row ${f.rowId}: ${f.error}`)
            .join("\n");
          const moreMsg = result.skippedRows > result.failedRows.length
            ? ` (showing first ${result.failedRows.length} of ${result.skippedRows})`
            : "";
          syncProgress.errors.push(
            `${tableName}: ${result.skippedRows} of ${result.prodCount} rows FAILED to insert${moreMsg}:\n${failedSamples}`
          );
        }

        if (result.prodCount > 0 && result.devCount === 0) {
          syncProgress.errors.push(
            `${tableName}: ALL ${result.prodCount} rows failed to insert — 0 rows in dev after sync`
          );
        } else if (result.skippedRows > 0) {
          syncProgress.warnings.push(
            `${tableName}: ${result.skippedRows} of ${result.prodCount} rows skipped — dev has ${result.devCount} rows vs prod ${result.prodCount}`
          );
        }
      } catch (err: any) {
        syncProgress.errors.push(`${tableName}: ${err.message}`);
      }
      syncProgress.tablesCompleted++;
    }

    const devClient3 = await devPool.connect();
    try {
      await devClient3.query("SET session_replication_role = 'origin'");
    } finally {
      devClient3.release();
    }

    syncProgress.currentTable = "Validating critical tables...";
    const mismatches = await runPostSyncValidation(prodPool);
    syncProgress.rowCountMismatches = mismatches;

    if (mismatches.length > 0) {
      for (const m of mismatches) {
        syncProgress.errors.push(
          `POST-SYNC VALIDATION: ${m.table} — prod has ${m.prodCount} rows, dev has ${m.devCount} rows`
        );
      }
    }

    const hasErrors = syncProgress.errors.length > 0 || mismatches.length > 0;
    syncProgress.status = hasErrors ? "error" : "completed";
    syncProgress.currentTable = hasErrors ? "Done (with errors)" : "Done";
    syncProgress.completedAt = new Date().toISOString();

    try {
      // The default park group's row (S2-17b round 4a): no conflict target, so
      // it reads the same with the old unique on key or without it (round 4b).
      await devPool.query(
        `WITH d AS (SELECT id FROM tenants WHERE slug = 'default' LIMIT 1),
              u AS (UPDATE settings SET value = $1, updated_at = NOW(), tenant_id = (SELECT id FROM d)
                     WHERE key = 'last_prod_sync'
                       AND (tenant_id IS NULL OR tenant_id IS NOT DISTINCT FROM (SELECT id FROM d))
                    RETURNING 1)
         INSERT INTO settings (key, value, updated_at, tenant_id)
         SELECT 'last_prod_sync', $1, NOW(), (SELECT id FROM d)
          WHERE NOT EXISTS (SELECT 1 FROM u)
         ON CONFLICT DO NOTHING`,
        [JSON.stringify({
          completedAt: syncProgress.completedAt,
          tablesCompleted: syncProgress.tablesCompleted,
          rowsCopied: syncProgress.rowsCopied,
          errorCount: syncProgress.errors.length,
          warningCount: syncProgress.warnings.length,
          rowCountMismatches: syncProgress.rowCountMismatches,
        })]
      );
    } catch (_e) {}
  } catch (err: any) {
    syncProgress.status = "error";
    syncProgress.errors.push(`Fatal: ${err.message}`);
    syncProgress.completedAt = new Date().toISOString();
  } finally {
    await prodPool.end();
  }
}

/**
 * The production-to-development copy. It empties and reloads the 174 tables
 * of `TABLE_ORDER` in the shared schema, `users.platform_user_id` and
 * `branches.core_branch_id` among them, so on any deployment it would undo
 * every link the platform has made. `NODE_ENV` used to be the only thing in
 * front of it, and staging runs the production build with throwaway data, so
 * the fence is `DEPLOY_ENV` (S2-17b round 1): it runs on a developer's machine
 * and nowhere else. The status read is fenced the same way; it names the last
 * sync's tables and counts.
 */
export function registerProdSyncRoutes(app: Express, requireAuth: any, requireGlobalAdmin: any) {
  app.post("/api/admin/prod-sync", devOnly(DEPLOY_ENV), requireAuth, requireGlobalAdmin, async (req: Request, res: Response) => {
    if (process.env.NODE_ENV === "production") {
      return res.status(403).json({ error: "This action can only be performed in the development environment." });
    }

    if (syncProgress.status === "running") {
      return res.status(409).json({ error: "A sync is already in progress.", progress: syncProgress });
    }

    const prodDbUrl = process.env.PRODUCTION_DATABASE_URL;
    if (!prodDbUrl) {
      return res.status(400).json({ error: "PRODUCTION_DATABASE_URL secret is not configured." });
    }

    runSync(prodDbUrl);

    res.json({ message: "Sync started", progress: syncProgress });
  });

  app.get("/api/admin/prod-sync/status", devOnly(DEPLOY_ENV), async (_req: Request, res: Response) => {
    if (process.env.NODE_ENV === "production") {
      return res.status(403).json({ error: "Not available in production." });
    }
    let lastSyncInfo = null;
    if (syncProgress.status === "idle") {
      try {
        const result = await devPool.query(
          `SELECT value FROM settings
            WHERE key = 'last_prod_sync'
              AND (tenant_id IS NULL OR tenant_id = (SELECT id FROM tenants WHERE slug = 'default'))
            ORDER BY tenant_id NULLS LAST LIMIT 1`,
        );
        if (result.rows.length > 0) {
          lastSyncInfo = JSON.parse(result.rows[0].value);
        }
      } catch (_e) {}
    }
    res.json({ ...syncProgress, lastSyncInfo });
  });
}
