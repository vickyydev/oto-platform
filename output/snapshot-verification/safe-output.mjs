import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const runnerRoot = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(runnerRoot, '..', '..');
const sensitive = new Set();
for (const [name, value] of Object.entries(process.env)) {
  if (/SECRET|PASSWORD|TOKEN|PIN|KEY|AUTH|URL|DSN/i.test(name) && value?.length >= 4) sensitive.add(value);
}
for (const file of ['.env', 'apps/console/e2e/console.ts']) {
  try {
    const source = readFileSync(resolve(repoRoot, file), 'utf8');
    for (const match of source.matchAll(/(?:phone|password)\s*:\s*['"]([^'"\r\n]+)['"]/g)) sensitive.add(match[1]);
    if (file === '.env') for (const line of source.split(/\r?\n/)) {
      const match = /^\s*([A-Z_0-9]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (match && /SECRET|PASSWORD|TOKEN|PIN|KEY|AUTH|URL|DSN/i.test(match[1])) {
        const value = match[2].replace(/^['"]|['"]$/g, '');
        if (value.length >= 4) sensitive.add(value);
      }
    }
  } catch { /* Optional local environment; never print its contents. */ }
}

export function safeError(error) {
  let text = String(error?.message ?? error ?? 'Unknown failure').split(/\r?\n/)[0];
  for (const value of [...sensitive].sort((a, b) => b.length - a.length)) text = text.split(value).join('[redacted]');
  return text.replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/(?:postgres(?:ql)?|https?):\/\/\S+/gi, '[url]')
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '[id]')
    .replace(/\d+/g, '[number]').slice(0, 400);
}
