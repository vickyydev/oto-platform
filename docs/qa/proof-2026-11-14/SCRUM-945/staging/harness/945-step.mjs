import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const root='C:/oto-lanes/audit-takeover-20261113';
const file=path.resolve(process.argv[2]??'');assert.ok(file.startsWith(path.resolve(root)+path.sep));assert.ok(path.basename(file).startsWith('945-'));assert.equal(path.extname(file),'.js');
const r=await fetch('http://127.0.0.1:47985/run',{method:'POST',headers:{'content-type':'text/plain'},body:fs.readFileSync(file,'utf8'),signal:AbortSignal.timeout(240000)});
const j=await r.json();console.log(JSON.stringify(j,null,2));if(!r.ok||j.ok!==true)process.exitCode=1;
