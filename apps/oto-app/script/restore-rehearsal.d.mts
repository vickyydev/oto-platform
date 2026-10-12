export function rehearseRestore(options?: {
  serverUrl?: string;
  structureFile?: string;
  pgBin?: string;
}): Promise<{
  cleanup: string;
  sourceTables: number;
  sourceRows: number;
  appMigrations: number;
  platformMigrations: number;
  counts: Record<string, string>;
  runs: {
    run: number;
    counts: Record<string, string>;
    views: Record<string, string>;
    migrations: { hash: string; created_at: string }[];
  }[];
}>;
