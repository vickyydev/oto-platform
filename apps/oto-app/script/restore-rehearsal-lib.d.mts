export function quoteIdentifier(value: string): string;
export function prepareStructureSql(input: string): string;
export function assertTableInventory(baselineSql: string, actual: Record<string, string>): string[];
export function runCommand(
  executable: string,
  args: string[],
  env: Record<string, string | undefined>,
  label: string,
  cwd?: string,
): string;
export function databaseUrl(server: string, name: string): string;
export function compareCounts(
  before: Record<string, string>,
  after: Record<string, string>,
): { table: string; before: string; after: string | null }[];
