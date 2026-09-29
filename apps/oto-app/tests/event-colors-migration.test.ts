import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import {
  CAMP_CALENDAR_COLOR,
  OTHER_EVENT_COLOR_OPTIONS,
  WORKSHOP_CALENDAR_COLOR,
  isBirthdayBranchColor,
  isHexCalendarColor,
} from "../shared/event-colors";

const databaseUrl = process.env.DATABASE_URL;
assert(databaseUrl, "DATABASE_URL is required to verify the calendar-color backfill");

const client = new Client({ connectionString: databaseUrl });
const fixtureSchema = `calendar_colors_test_${process.pid}_${Date.now()}`;

type BranchColorRow = {
  id: string;
  tenant_id: string;
  name: string;
  calendar_color: string | null;
};

function assertValidUniqueAssignments(rows: BranchColorRow[]) {
  const colorsByTenant = new Map<string, Set<string>>();
  for (const branch of rows) {
    assert(isHexCalendarColor(branch.calendar_color), `${branch.name} is missing a persisted calendar color`);
    assert(isBirthdayBranchColor(branch.calendar_color, branch.name), `${branch.name} has an invalid birthday color`);
    assert(
      branch.calendar_color.toLowerCase() !== CAMP_CALENDAR_COLOR
        && branch.calendar_color.toLowerCase() !== WORKSHOP_CALENDAR_COLOR
        && !OTHER_EVENT_COLOR_OPTIONS.some(({ value }) => value === branch.calendar_color.toLowerCase()),
      `${branch.name} uses a fixed or Other Event calendar color`,
    );

    const tenantColors = colorsByTenant.get(branch.tenant_id) ?? new Set<string>();
    assert(
      !tenantColors.has(branch.calendar_color.toLowerCase()),
      `${branch.name} reuses another branch's calendar color within its tenant`,
    );
    tenantColors.add(branch.calendar_color.toLowerCase());
    colorsByTenant.set(branch.tenant_id, tenantColors);
  }
}

try {
  await client.connect();
  await client.query("SET search_path TO otoapp");
  const reconciliationSql = await readFile(
    path.resolve(process.cwd(), "migrations/pre-platform/0016_add_calendar_event_color_system.sql"),
    "utf8",
  );

  const { rows: indexes } = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname = current_schema()
        AND indexname = 'branches_tenant_calendar_color_unique'
    ) AS exists`,
  );
  assert.equal(indexes[0]?.exists, true, "tenant color uniqueness index must exist");

  await client.query(`CREATE SCHEMA "${fixtureSchema}"`);
  await client.query(`SET search_path TO "${fixtureSchema}"`);
  await client.query("CREATE TYPE core_event_type AS ENUM ('birthday')");
  await client.query(`
    CREATE TABLE branches (
      id varchar PRIMARY KEY,
      tenant_id uuid NOT NULL,
      name text NOT NULL,
      created_at timestamp NOT NULL,
      calendar_color text
    )
  `);
  await client.query(`
    INSERT INTO branches (id, tenant_id, name, created_at, calendar_color) VALUES
      ('a-valid',   '11111111-1111-1111-1111-111111111111', 'Alpha',       '2026-01-01', '#abcdef'),
      ('a-missing', '11111111-1111-1111-1111-111111111111', 'Beta',        '2026-01-02', NULL),
      ('a-invalid', '11111111-1111-1111-1111-111111111111', 'Gamma',       '2026-01-03', '#10b981'),
      ('a-duplicate','11111111-1111-1111-1111-111111111111', 'Delta',      '2026-01-04', '#ABCDEF'),
      ('a-named',   '11111111-1111-1111-1111-111111111111', 'BD Chalong',  '2026-01-05', NULL),
      ('b-valid',   '22222222-2222-2222-2222-222222222222', 'Epsilon',     '2026-01-01', '#abcdef'),
      ('b-missing', '22222222-2222-2222-2222-222222222222', 'Zeta',        '2026-01-02', NULL)
  `);

  await client.query(reconciliationSql);
  const { rows: repairedRows } = await client.query<BranchColorRow>(
    "SELECT id, tenant_id, name, calendar_color FROM branches ORDER BY tenant_id, created_at, id",
  );
  assertValidUniqueAssignments(repairedRows);
  const repairedAssignments = new Map(repairedRows.map((branch) => [branch.id, branch.calendar_color]));
  assert.equal(repairedAssignments.get("a-valid"), "#abcdef", "valid assignments must be preserved");
  assert.equal(
    repairedAssignments.get("b-valid"),
    "#abcdef",
    "the same color may be reused safely by a different tenant",
  );
  assert.notEqual(repairedAssignments.get("a-duplicate")?.toLowerCase(), "#abcdef", "duplicates must be repaired");
  assert.notEqual(repairedAssignments.get("a-invalid"), CAMP_CALENDAR_COLOR, "reserved colors must be repaired");

  await client.query(reconciliationSql);
  const { rows: repairedRerunRows } = await client.query<{ id: string; calendar_color: string }>(
    "SELECT id, calendar_color FROM branches ORDER BY id",
  );
  assert.deepEqual(
    new Map(repairedRerunRows.map((branch) => [branch.id, branch.calendar_color])),
    repairedAssignments,
    "fixture assignments must remain stable on repeat reconciliation",
  );

  await assert.rejects(
    client.query(`
      INSERT INTO branches (id, tenant_id, name, created_at, calendar_color)
      VALUES ('a-collision', '11111111-1111-1111-1111-111111111111', 'Collision', now(), '#abcdef')
    `),
    (error: NodeJS.ErrnoException & { code?: string }) => error.code === "23505",
    "the database must reject a same-tenant color collision",
  );

  console.log(`Verified calendar-color reconciliation for ${repairedRows.length} fixture branches.`);
} finally {
  if ((client as unknown as { _connected?: boolean })._connected) {
    await client.query("SET search_path TO public");
    await client.query(`DROP SCHEMA IF EXISTS "${fixtureSchema}" CASCADE`);
  }
  await client.end();
}
