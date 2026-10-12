/** Pure guards shared by the rehearsal and its review checks. */
import { execFileSync } from 'node:child_process';

export function runCommand(executable, args, env, label, cwd) {
  try {
    return execFileSync(executable, args, {
      cwd,
      env,
      encoding: 'utf8',
      stdio: 'pipe',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    // Child errors can echo URLs, SQL and data; retain only the named step.
    throw new Error(`Restore rehearsal stopped at ${label}; no child output was published.`);
  }
}

export function quoteIdentifier(value) {
  return `"${value.replace(/"/g, '""')}"`;
}

export function compareCounts(before, after) {
  const differences = [];
  for (const [table, count] of Object.entries(before)) {
    if (after[table] !== count)
      differences.push({ table, before: count, after: after[table] ?? null });
  }
  return differences;
}

export function databaseUrl(server, name) {
  if (!/^oto_rehearsal_[a-f0-9_]+$/.test(name))
    throw new Error('Refusing a database name outside this rehearsal.');
  const url = new URL(server);
  if (!['postgres:', 'postgresql:'].includes(url.protocol))
    throw new Error('REHEARSAL_DATABASE_URL must use PostgreSQL.');
  url.pathname = `/${name}`;
  return url.toString();
}
