import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase } from '@oto/db/testing';

/**
 * SCRUM-517: preview the existing Fix department roster before saving.
 * Passing controls drive the real Express handler and database reader.
 * FINDING 1 (high, fixed): historical cross-park department links must not
 * expose a foreign employee or advisor. Prescribed fix: join the owned
 * department and constrain employee/access-policy park on both roster reads.
 * FINDING 2 (medium, fixed): changing a selection must not save before the
 * preview is reviewed. Prescribed fix: draft selection and explicit Save.
 * FINDING 3 (high, fixed): a department and policy cannot confer ownership
 * on a foreign or unplaced person. Prescribed fix: canonical person park
 * must also match, retaining nullable unplaced records outside the roster.
 * No routing/status rule, delivery channel, migration or branch choice changes.
 */
const APP = fileURLToPath(new URL('../../oto-app/', import.meta.url));
const available = existsSync(join(APP, 'node_modules/tsx/dist/cli.mjs'));
let proof: Record<string, boolean>;

function removeFixtureDirectory(directory: string) {
  const local = relative(tmpdir(), directory);
  if (!local.startsWith('oto-fix-preview-') || local.includes('..') || isAbsolute(local)) throw new Error('Temporary cleanup boundary');
  rmSync(directory, { recursive: true, force: true });
}


describe.skipIf(!available)('Fix recipient preview review', () => {
  beforeAll(async () => {
    const database = await createTestDatabase({ otoapp: true });
    const directory = mkdtempSync(join(tmpdir(), 'oto-fix-preview-'));
    try {
      const script = join(directory, 'preview.mts');
      writeFileSync(script, String.raw`
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
const app=${JSON.stringify(APP)};
const require=createRequire(app+'package.json');
const express=require('express'),pg=require('pg');
process.on('unhandledRejection',error=>{console.log('FIX_PREVIEW_SETUP='+JSON.stringify({code:error?.code,column:error?.column,table:error?.table}));process.exit(1);});
const {drizzle}=require('drizzle-orm/node-postgres');
const {registerFixRecipientPreview,readFixDepartmentMembers}=await import(pathToFileURL(app+'server/fix-recipient-preview.ts').href);
const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();await c.query('set search_path to otoapp');
const database=drizzle(c);const groups=[];const result={};let server;
try{
 for(const label of ['A','B']){
  const tenant=randomUUID(),department=randomUUID(),user=randomUUID();
  await c.query('insert into tenants(id,name,slug) values($1,$2,$3)',[tenant,'ZZ TEST '+label,'zz-'+tenant]);
  await c.query('insert into departments(id,tenant_id,name) values($1,$2,$3)',[department,tenant,'ZZ TEST Department '+label]);
  await c.query("insert into users(id,email,password,full_name,role) values($1,$2,'ZZ TEST unused credential',$3,'admin')",[user,user+'@zz-test.invalid','ZZ TEST Admin '+label]);
  await c.query("insert into employees(tenant_id,full_name,nickname,email,user_id,primary_department_id) values($1,$2,'ZZ TEST',$3,$4,$5)",[tenant,'ZZ TEST Employee '+label,randomUUID()+'@zz-test.invalid',user,department]);
  const person=randomUUID();
  await c.query("insert into people(id,tenant_id,full_name,email,person_type) values($1,$2,$3,$4,'ADVISOR')",[person,tenant,'ZZ TEST Advisor '+label,randomUUID()+'@zz-test.invalid']);
  await c.query("insert into access_policies(tenant_id,person_id,access_level,core_user_id,modules,branch_scope) values($1,$2,'staff',$3,'{}','ALL')",[tenant,person,user]);
  await c.query('update people set department_id=$1 where id=$2',[department,person]);
  groups.push({tenant,department,user});
 }
 const [a,b]=groups;
 const api=express();api.use((req,_res,next)=>{const actor=req.headers['x-test-actor'];const group=actor==='b'?b:a;req.user=actor?{role:actor==='staff'?'staff':'admin',hasAllBranchesAccess:false}:undefined;req.userWithAccess=actor==='missing'?undefined:{tenantId:group.tenant};next();});
 registerFixRecipientPreview(api,database,(req,res,next)=>req.user?next():res.status(401).json({message:'Sign in required'}));
 api.use((_error,_req,res,_next)=>res.status(500).json({message:'Test request failed'}));
 server=await new Promise(resolve=>{const s=api.listen(0,'127.0.0.1',()=>resolve(s));});const origin='http://127.0.0.1:'+server.address().port;
 const get=async(id,actor='a')=>{const r=await fetch(origin+'/api/settings/fix-department/recipients?departmentId='+encodeURIComponent(id),{headers:actor?{'x-test-actor':actor}:{},signal:AbortSignal.timeout(5000)});return {status:r.status,body:await r.json()};};
 const own=await get(a.department);result.own=own.status===200&&own.body.count===2&&own.body.members.some(x=>x.name==='ZZ TEST Employee A')&&own.body.members.some(x=>x.name==='ZZ TEST Advisor A');
 result.foreign=(await get(a.department,'b')).status===404;result.roles=(await get(a.department,'staff')).status===403&&(await get(a.department,'')).status===401&&(await get(a.department,'missing')).status===403;
 const otherBranchDept=randomUUID();await c.query('insert into departments(id,tenant_id,name) values($1,$2,$3)',[otherBranchDept,a.tenant,'ZZ TEST Other Department']);const empty=await get(otherBranchDept);result.empty=empty.status===200&&empty.body.count===0&&(await get('')).body.department===null;
 await c.query("insert into employees(tenant_id,full_name,nickname,email,user_id,primary_department_id) values($1,'ZZ TEST Historical Foreign Employee','ZZ TEST',$2,$3,$4)",[b.tenant,randomUUID()+'@zz-test.invalid',b.user,a.department]);
 const foreignPerson=randomUUID();await c.query("insert into people(id,tenant_id,full_name,email,person_type,department_id) values($1,$2,'ZZ TEST Historical Foreign Advisor',$3,'ADVISOR',$4)",[foreignPerson,a.tenant,randomUUID()+'@zz-test.invalid',a.department]);await c.query("insert into access_policies(tenant_id,person_id,access_level,core_user_id,modules,branch_scope) values($1,$2,'staff',$3,'{}','ALL')",[b.tenant,foreignPerson,b.user]);
 const historical=await get(a.department);result.historical=historical.status===200&&historical.body.count===2&&!historical.body.members.some(x=>x.name.includes('Historical'));
 for(const owner of [b.tenant,null]){const person=randomUUID();await c.query("insert into people(id,tenant_id,full_name,email,person_type,department_id) values($1,$2,$3,$4,'ADVISOR',$5)",[person,owner,owner?'ZZ TEST Canonical Foreign Advisor':'ZZ TEST Unplaced Advisor',randomUUID()+'@zz-test.invalid',a.department]);await c.query("insert into access_policies(tenant_id,person_id,access_level,core_user_id,modules,branch_scope) values($1,$2,'staff',$3,'{}','ALL')",[a.tenant,person,a.user]);}
 const canonical=await get(a.department);result.canonical=canonical.status===200&&canonical.body.count===2&&!canonical.body.members.some(x=>x.name.includes('Canonical')||x.name.includes('Unplaced'));
 const direct=(await readFixDepartmentMembers(database,a.tenant,[a.department])).get(a.department);result.sameRoster=JSON.stringify(direct)===JSON.stringify(canonical.body.members);
 const census=async()=>(await c.query('select (select count(*) from settings)::int settings,(select count(*) from fix_reports)::int reports,(select count(*) from notifications)::int notifications')).rows[0];const before=await census();for(let i=0;i<3;i++)await get(a.department);const after=await census();result.replay=JSON.stringify(before)===JSON.stringify(after);
 console.log('FIX_PREVIEW_PROOF='+JSON.stringify(result));
}finally{if(server)await new Promise(resolve=>server.close(resolve));await c.end();}
`);
      const run = spawnSync(process.execPath, [join(APP, 'node_modules/tsx/dist/cli.mjs'), '--tsconfig', join(APP, 'tsconfig.json'), script], {
        cwd: APP, env: { ...process.env, DATABASE_URL: database.url }, encoding: 'utf8', timeout: 60_000,
      });
      const match = /FIX_PREVIEW_PROOF=(.+)/.exec(run.stdout ?? '');
      if (!match) {
        const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
        const classes = [...output.matchAll(/\b(?:Error|TypeError|SyntaxError|ReferenceError|ERR_MODULE_NOT_FOUND)\b/g)].map(x => x[0]);
        const frames = [...output.matchAll(/[A-Za-z0-9_-]+\.(?:ts|mts|js|mjs):\d+:\d+/g)].map(x => x[0]);
        console.info('Fix preview setup metadata', { classes, frames, database: /FIX_PREVIEW_SETUP=(.+)/.exec(output)?.[1] });
      }
      expect(run.status, 'The bounded preview fixture finished').toBe(0);
      expect(match, 'The real handler produced its review results').not.toBeNull();
      if (!match?.[1]) throw new Error('The preview fixture did not return its results');
      proof = JSON.parse(match[1]);
    } finally {
      await database.drop();
      removeFixtureDirectory(directory);
    }
  }, 180_000);

  it('the owning administrator previews employees and advisors through the current roster', () => expect(proof.own && proof.sameRoster).toBe(true));
  it('another park, a restricted branch reader, a signed-out reader and missing context are refused', () => expect(proof.foreign && proof.roles).toBe(true));
  it('an empty owned department and no department have explicit empty previews', () => expect(proof.empty).toBe(true));
  it('FINDING 1 (high, fixed): historical foreign department links stay outside the preview; prescribed fix: owned department and employee/policy park filters', () => expect(proof.historical).toBe(true));
  it('FINDING 3 (high, fixed): own department and policy cannot admit a foreign or unplaced person; prescribed fix: canonical person park filter', () => expect(proof.canonical).toBe(true));
  it('replayed previews create no report, setting or notification', () => expect(proof.replay).toBe(true));
  it('FINDING 2 (medium, fixed): the selection waits for explicit Save; prescribed fix: draft selection and preview before mutation', () => {
    const ui = readFileSync(join(APP, 'client/src/components/fix-department-section.tsx'), 'utf8');
    expect(ui).toContain('onValueChange={setDraftDepartment}');
    expect(ui).toContain('data-testid="button-save-fix-department"');
    expect(ui).toContain('previewLoading || previewFailed || !preview');
    expect(ui).toContain('Staff in this department: {preview.count}');
  });
});
