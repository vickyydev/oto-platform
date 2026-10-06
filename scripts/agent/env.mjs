// Loads the repo-root .env (never committed) into process.env for the
// agent helpers. Values already set in the environment win.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const file = resolve(ROOT, '.env');
if (existsSync(file)) {
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

/** Read a required setting. The error names the setting, never a value. */
export function need(key) {
  const v = process.env[key];
  if (!v) throw new Error(`Set ${key} in the environment (or the repo-root .env).`);
  return v;
}
