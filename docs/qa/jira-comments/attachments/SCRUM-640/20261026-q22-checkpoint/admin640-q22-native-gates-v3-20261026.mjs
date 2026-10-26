import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
const root='C:/w/admin-operator-switch',phase=process.argv[2],attempt=process.argv[3];
const groups={
  'broad-green':'pnpm --filter @oto/api test test/auth.test.ts test/auth-codes.test.ts test/auth-enumeration.test.ts test/permissions.test.ts test/archived-tenancy.test.ts test/session-branch-station.test.ts test/transactions.test.ts test/handoff.test.ts test/handoff-department.test.ts test/auth-handoff-files-tx.test.ts test/s629-handoff-role.test.ts test/s629-role-mapping-review.test.ts test/operator-switch-handoff-review.test.ts test/routes-guarded.test.ts test/route-write-conformance.test.ts test/id-conformance.test.ts test/route-scope-target.test.ts test/platform-review.test.ts test/console-branch-scope.test.ts test/scrum-607-reach.test.ts test/operator-switch-review.test.ts test/operator-switch-seat-review.test.ts test/operator-switch-session-review.test.ts test/operator-switch-idempotency-review.test.ts test/operator-switch-route-review.test.ts test/operator-switch-audit-context-review.test.ts test/operator-switch-lifecycle-review.test.ts',
  'handoff-red':'pnpm --filter @oto/api test test/operator-switch-handoff-review.test.ts',
  'handoff-green':'pnpm --filter @oto/api test test/operator-switch-handoff-review.test.ts',
  'lifecycle-red':'pnpm --filter @oto/api test test/operator-switch-lifecycle-review.test.ts',
  'lifecycle-green':'pnpm --filter @oto/api test test/operator-switch-lifecycle-review.test.ts',
  'audit-red':'pnpm --filter @oto/api test test/operator-switch-audit-context-review.test.ts',
  'audit-green':'pnpm --filter @oto/api test test/operator-switch-audit-context-review.test.ts',
  'migration-red':'pnpm --filter @oto/db test test/s640-operator-switch-migration.test.ts',
  'migration-green':'pnpm --filter @oto/db test test/s640-operator-switch-migration.test.ts',
  schema:'pnpm --filter @oto/db verify-schema',
  checks:'pnpm --filter @oto/api typecheck\npnpm --filter @oto/db typecheck\npnpm --filter @oto/api-types typecheck\npnpm api-types:check\npnpm --filter @oto/api-types test',
};
if(!Object.hasOwn(groups,phase??'')||!/^v[1-9][0-9]*$/.test(attempt??''))throw Error('EXACT_Q22_NATIVE_ATTEMPT_REQUIRED');
const out='C:/w/admin640-q22-'+phase+'-'+attempt;
for(const ending of ['.json','.log','.inputs.json'])if(fs.existsSync(out+ending))throw Error('PRESERVE_Q22_ATTEMPT');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function walk(relative){return fs.readdirSync(path.join(root,relative),{withFileTypes:true}).flatMap(item=>{
  const next=relative+'/'+item.name;return item.isDirectory()?walk(next):item.isFile()?[next]:[];
});}
const fixed=['apps/api/package.json','apps/api/tsconfig.json','apps/api/vitest.config.ts','packages/db/package.json',
  'packages/db/tsconfig.json','packages/db/migrations/0087_operator_switch.sql','packages/db/migrations/meta/0087_snapshot.json',
  'packages/db/migrations/meta/_journal.json','pnpm-lock.yaml','package.json'];
const frame=()=>Object.fromEntries([...new Set([...fixed,...['apps/api/src','apps/api/test','packages/db/src',
  'packages/db/test','packages/shared/src','packages/api-types/src'].flatMap(walk)])].sort()
  .map(name=>[name,sha(fs.readFileSync(path.join(root,name)))]));
const before=frame(),startedAt=new Date().toISOString(),chunks=[];
const env={...process.env,NO_COLOR:'1',FORCE_COLOR:'0',CONSOLE_DIGEST_ENABLED:'false',ALERT_WEBHOOK_URL:''};
delete env.DATABASE_URL;delete env.TEST_DATABASE_URL;
const command=groups[phase],child=spawn('C:/Program Files/Git/bin/bash.exe',['-lc','set -eo pipefail\n'+command],
  {cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
child.stdout.on('data',chunk=>chunks.push(chunk));child.stderr.on('data',chunk=>chunks.push(chunk));
let launchError=null;child.on('error',error=>{launchError=error.code??'LAUNCH_FAILED';});
const terminal=await new Promise(resolve=>child.on('close',(exitCode,signal)=>resolve({exitCode,signal})));
const log=Buffer.concat(chunks).toString('utf8').replace(/postgres(?:ql)?:\/\/[^\s'"<>]+/gi,'[DATABASE_URL_REDACTED]')
  .replace(/oto_session=[A-Za-z0-9._%+-]+/g,'oto_session=[REDACTED]')
  .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,'[JWT_REDACTED]')
  .replace(/((?:password|temporarypassword|handoff_signing_key|sessiontoken)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,'$1[REDACTED]');
fs.writeFileSync(out+'.log',log,{flag:'wx'});
const after=frame(),inputs=JSON.stringify({before,after},null,2)+'\n';fs.writeFileSync(out+'.inputs.json',inputs,{flag:'wx'});
const record={ticket:'SCRUM-640',phase,attempt,startedAt,completedAt:new Date().toISOString(),command,...terminal,launchError,
  inputsUnchanged:JSON.stringify(before)===JSON.stringify(after),inputCount:Object.keys(before).length,
  sourceManifestSha256:sha(JSON.stringify(before)),inputsSha256:sha(inputs),runnerSha256:sha(fs.readFileSync(new URL(import.meta.url))),
  logSha256:sha(log),logPath:out+'.log',isolatedEmbeddedDatabase:true,inheritedDatabaseSettingsDiscarded:true,staging:false,release:false};
fs.writeFileSync(out+'.json',JSON.stringify(record,null,2)+'\n',{flag:'wx'});
process.stdout.write(JSON.stringify(record)+'\n');process.exitCode=terminal.exitCode??1;
