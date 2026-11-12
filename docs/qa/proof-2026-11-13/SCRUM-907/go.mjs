// Send one step file's body to the driver: node go.mjs <step file> [port]
import { readFileSync } from 'node:fs';
const [file, port = '47907'] = process.argv.slice(2);
const body = readFileSync(file, 'utf8');
const r = await fetch(`http://127.0.0.1:${port}/run`, { method: 'POST', body, signal: AbortSignal.timeout(1_500_000) });
const t = await r.text();
console.log(t.slice(0, 14000));
