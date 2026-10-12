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

/** Only SQL is handed to the fixed database connection, never psql commands. */
export function prepareStructureSql(input) {
  if (input.includes('\0')) throw new Error('Structure input contains a NUL byte.');
  let restriction;
  const lines = [];
  for (const line of input.split(/\r?\n/)) {
    // Recent pg_dump clients wrap plain dumps in matched restriction markers.
    // Strip those inert wrappers; no other backslash command is accepted.
    const marker = line.match(/^\s*\\(unrestrict|restrict)\s+([A-Za-z0-9_-]+)\s*$/);
    if (marker) {
      if (marker[1] === 'restrict' && !restriction) restriction = marker[2];
      else if (marker[1] === 'unrestrict' && restriction === marker[2]) restriction = undefined;
      else throw new Error('Structure input has unmatched restriction markers.');
      continue;
    }
    if (/^\s*\\/.test(line))
      throw new Error('Structure input contains a client command; SQL only is accepted.');
    lines.push(line);
  }
  if (restriction) throw new Error('Structure input has unmatched restriction markers.');
  return lines.join('\n');
}

export function assertTableInventory(baselineSql, actual) {
  const expected = [...baselineSql.matchAll(/^CREATE TABLE "([^"]+)"/gm)]
    .map((match) => match[1])
    .sort();
  const names = Object.keys(actual).sort();
  if (expected.length !== 184 || new Set(expected).size !== expected.length) {
    throw new Error('The committed baseline table inventory is inconsistent.');
  }
  if (JSON.stringify(expected) !== JSON.stringify(names)) {
    throw new Error(
      'The source table inventory differs from the committed baseline; no baseline adoption was accepted.',
    );
  }
  return expected;
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
