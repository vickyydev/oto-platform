import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
const cwd='C:/w/admin-operator-switch', attempt=process.argv[2];
if(!/^v[1-9][0-9]*$/.test(attempt??''))throw Error('EXACT_ATTEMPT_REQUIRED');
const out='C:/w/admin640-final-scoped-'+attempt;
for(const extension of ['.json','.log','.inputs.json'])if(fs.existsSync(out+extension))throw Error('PRESERVE_FINAL_SCOPED_ATTEMPT');
const git=args=>execFileSync('git',args,{cwd,windowsHide:true,maxBuffer:16*1024*1024}).toString().split('\0').filter(Boolean);
const lintFiles=[...new Set([...git(['diff','--name-only','-z','origin/main']),...git(['ls-files','--others','--exclude-standard','-z'])])]
  .filter(name=>/^(apps|packages)\//.test(name)&&/\.(?:ts|tsx|mjs)$/.test(name)&&name!=='packages/api-types/src/openapi.ts').sort();
if(!lintFiles.length)throw Error('NO_CHANGED_SOURCE_FILES');
const names=[...new Set([...lintFiles,'packages/api-types/src/openapi.ts','packages/api-types/openapi.json','pnpm-lock.yaml',
  'packages/db/migrations/meta/_journal.json','apps/api/package.json','apps/console/package.json','packages/api-types/package.json'])].sort();
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const frame=()=>Object.fromEntries(names.map(name=>[name,hash(fs.readFileSync(path.join(cwd,name)))]));
const quote=value=>"'"+value.replace(/'/g,"'\\''")+"'";
const command=['pnpm --filter @oto/api typecheck','pnpm --filter @oto/api-types typecheck',
  'pnpm api-types:check','pnpm --filter @oto/api-types test','pnpm exec eslint '+lintFiles.map(quote).join(' '),'git diff --check'].join('\n');
const before=frame(),startedAt=new Date().toISOString(),chunks=[],env={...process.env,NO_COLOR:'1',FORCE_COLOR:'0'};
delete env.DATABASE_URL;delete env.TEST_DATABASE_URL;
const child=spawn('C:/Program Files/Git/bin/bash.exe',['-lc','set -eo pipefail\n'+command],
  {cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
child.stdout.on('data',chunk=>chunks.push(chunk));child.stderr.on('data',chunk=>chunks.push(chunk));
let launchError=null;child.on('error',error=>{launchError=error.code??'LAUNCH_FAILED';});
const terminal=await new Promise(resolve=>child.on('close',(exitCode,signal)=>resolve({exitCode,signal})));
const log=Buffer.concat(chunks).toString('utf8').replace(/postgres(?:ql)?:\/\/[^\s'"<>]+/gi,'[DATABASE_URL_REDACTED]')
  .replace(/oto_session=[A-Za-z0-9._%+-]+/g,'oto_session=[REDACTED]')
  .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,'[JWT_REDACTED]');
fs.writeFileSync(out+'.log',log,{flag:'wx'});
const after=frame(),inputs=JSON.stringify({before,after},null,2)+'\n';
fs.writeFileSync(out+'.inputs.json',inputs,{flag:'wx'});
const receipt={ticket:'SCRUM-640',attempt,startedAt,completedAt:new Date().toISOString(),command,...terminal,launchError,
  inputCount:names.length,lintFiles,inputsUnchanged:JSON.stringify(before)===JSON.stringify(after),
  inputsSha256:hash(inputs),sourceManifestSha256:hash(JSON.stringify(before)),runnerSha256:hash(fs.readFileSync(new URL(import.meta.url))),
  logSha256:hash(log),logPath:out+'.log',staging:false,release:false};
fs.writeFileSync(out+'.json',JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
process.stdout.write(JSON.stringify({ticket:receipt.ticket,attempt,exitCode:terminal.exitCode,lintFiles:lintFiles.length,
  inputsUnchanged:receipt.inputsUnchanged,logPath:receipt.logPath,logSha256:receipt.logSha256})+'\n');
process.exitCode=terminal.exitCode??1;
