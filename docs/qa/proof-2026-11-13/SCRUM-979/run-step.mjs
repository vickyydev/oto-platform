import { readFileSync } from 'node:fs';
import { request } from 'node:http';
const body = readFileSync(process.argv[2], 'utf8');
const result = await new Promise((resolve, reject) => {
  const req = request('http://127.0.0.1:47979/run', { method: 'POST', timeout: 900000 }, response => {
    let text = '';
    response.setEncoding('utf8');
    response.on('data', chunk => { text += chunk; });
    response.on('end', () => { try { resolve(JSON.parse(text)); } catch (error) { reject(error); } });
  });
  req.on('timeout', () => req.destroy(new Error('Proof step timed out')));
  req.on('error', reject);
  req.end(body);
});
console.log(JSON.stringify(result));
if (!result.ok) process.exitCode = 1;
