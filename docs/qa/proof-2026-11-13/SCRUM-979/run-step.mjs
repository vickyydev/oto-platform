import { readFileSync } from 'node:fs';
const body = readFileSync(process.argv[2], 'utf8');
const r = await fetch('http://127.0.0.1:47979/run', { method: 'POST', body, signal: AbortSignal.timeout(900000) });
const result = await r.json();
console.log(JSON.stringify(result));
if (!result.ok) process.exitCode = 1;
