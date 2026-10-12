import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase } from '@oto/db/testing';

/**
 * SCRUM-191 round 7, independent registered-model and shared-role review.
 * FINDING 1 (medium): the presence model's custom primary-key lookup must
 * apply the same park-group predicate as the base model before enrichment.
 * Q54 (low, standing): owner-only shared-role authoring is an alternative
 * awaiting a ruling. The shared dictionary, including metadata/deactivation,
 * remains the app's approved default. Private roles and holders stay scoped.
 */
const APP = fileURLToPath(new URL('../../oto-app/', import.meta.url));
const available = existsSync(join(APP, 'node_modules/tsx/dist/cli.mjs'));
type Result = {
  presenceOwn: number;
  presenceForeign: number;
  sharedRead: number;
  privateRead: number;
  privatePatch: number;
  privateDeactivate: number;
  sharedPatch: number;
  sharedDeactivate: number;
  sharedCreate: number;
  privateUnchanged: boolean;
  defaultCreatePreserved: boolean;
  ownBranchesPreserved: boolean;
  foreignBranchesPreserved: boolean;
  roleListScoped: boolean;
  ownRoleRead: number;
  policyForeignUser: number;
  policyOwnUser: number;
  policyMalformedBranches: number;
  overrideMalformedBranches: number;
};
let result: Result;

async function run(
  executable: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(executable, args, { cwd: APP, env: environment, stdio: 'pipe' });
      let stdout = '',
        stderr = '';
      child.stdout.on('data', (part) => {
        stdout += part.toString();
      });
      child.stderr.on('data', (part) => {
        stderr += part.toString();
      });
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error('ZZ TEST access child did not finish'));
      }, timeoutMs);
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('exit', (status) => {
        clearTimeout(timeout);
        resolve({ status, stdout, stderr });
      });
    },
  );
}

describe.skipIf(!available)('round 7 independent model and role review over HTTP', () => {
  beforeAll(async () => {
    const database = await createTestDatabase();
    const directory = mkdtempSync(join(tmpdir(), 'oto-r7-access-cross-'));
    try {
      const migrated = await run(
        process.execPath,
        [join(APP, 'script/migrate.mjs')],
        {
          ...process.env,
          DATABASE_URL: database.url,
        },
        180_000,
      );
      expect(migrated.status, migrated.stderr).toBe(0);
      const script = join(directory, 'access-review.mts');
      writeFileSync(
        script,
        `
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomBytes,randomUUID,scryptSync} from 'node:crypto';
import {createRequire} from 'node:module';
const app=${JSON.stringify(APP)};
const require=createRequire(app+'package.json');const pg=require('pg');
const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();await c.query('set search_path to otoapp');
const password=randomBytes(24).toString('hex'),salt=randomBytes(16).toString('hex');const hash=scryptSync(password,salt,64).toString('hex')+'.'+salt;
const groups=[];const rows={};let server;let origin;
async function call(method,path,cookie,body){const response=await fetch(origin+path,{method,headers:{cookie,...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});const text=await response.text();return {status:response.status,data:text?JSON.parse(text):null};}
try {
 for(const tag of ['default','A','B']){
  const tenant=(await c.query('insert into tenants(name,slug) values($1,$2) returning id',['ZZ TEST Cross '+tag,tag==='default'?'default':'zz-cross-'+tag+'-'+randomUUID()])).rows[0].id;
  const branch=(await c.query("insert into branches(tenant_id,name,address) values($1,$2,'ZZ TEST address') returning id",[tenant,'ZZ TEST Cross Branch '+tag])).rows[0].id;
  const id=randomUUID(),email='zz-cross-'+tag+'-'+randomUUID()+'@example.invalid';
  await c.query("insert into users(id,email,password,full_name,role) values($1,$2,$3,$4,'admin')",[id,email,hash,'ZZ TEST Cross Admin '+tag]);
  await c.query("insert into user_branch_access(tenant_id,user_id,access_scope) values($1,$2,'all_branches')",[tenant,id]);
  groups.push({tenant,branch,id,email,cookie:''});
 }
 const [shared,a,b]=groups;
 const employee=(await c.query("insert into employees(tenant_id,branch_id,full_name,nickname,email) values($1,$2,'ZZ TEST Presence Employee','ZZ TEST Presence',$3) returning id",[a.tenant,a.branch,'zz-presence-'+randomUUID()+'@example.invalid'])).rows[0].id;
 await c.query("insert into employee_presence(employee_id,tenant_id,is_clocked_in,current_work_branch_id,last_event_at,last_event_type) values($1,$2,true,$3,now(),'IN')",[employee,a.tenant,a.branch]);
 const sharedRole=(await c.query("insert into roles(tenant_id,name) values($1,'ZZ TEST Shared Dictionary Role') returning id",[shared.tenant])).rows[0].id;
 const privateRole=(await c.query("insert into roles(tenant_id,name) values($1,'ZZ TEST Private Role A') returning id",[a.tenant])).rows[0].id;
 const bRole=(await c.query("insert into roles(tenant_id,name) values($1,'ZZ TEST Private Role B') returning id",[b.tenant])).rows[0].id;
 await c.query('insert into role_branch_assignments(role_id,branch_id) values($1,$2),($1,$3)',[sharedRole,a.branch,b.branch]);
 server=spawn(process.execPath,[app+'node_modules/tsx/dist/cli.mjs','tests/harness/serve-routes.ts'],{cwd:app,env:{...process.env,NODE_ENV:'test',APP_ENV:'dev',STORAGE_ENV_PREFIX:'zz-cross',OBJECT_STORAGE:'local',DEPLOY_ENV:'local',OTOAPP_LEGACY_LOGIN:'true',OTOAPP_JOBS:'platform',USE_AWS_REKOGNITION:'false',LOG_LEVEL:'warn',SESSION_SECRET:randomBytes(24).toString('hex')},stdio:['ignore','pipe','pipe']});
 origin=await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(new Error('ZZ TEST access harness timed out')),180000);const read=part=>{output+=part.toString();const match=/HARNESS_PORT=(\\d+)/.exec(output);if(match){clearTimeout(timer);resolve('http://127.0.0.1:'+match[1]);}};server.stdout.on('data',read);server.stderr.on('data',read);server.once('exit',()=>{clearTimeout(timer);reject(new Error('ZZ TEST access harness exited before listening'));});});
 for(const group of groups){const response=await fetch(origin+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({identifier:group.email,password})});assert.equal(response.status,200);group.cookie=response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');}
 rows.presenceOwn=(await call('GET','/api/data-admin/employee-presences/'+employee,a.cookie)).status;
 rows.presenceForeign=(await call('GET','/api/data-admin/employee-presences/'+employee,b.cookie)).status;
 rows.sharedRead=(await call('GET','/api/roles/'+sharedRole,b.cookie)).status;
 rows.privateRead=(await call('GET','/api/roles/'+privateRole,b.cookie)).status;
 rows.privatePatch=(await call('PATCH','/api/roles/'+privateRole,b.cookie,{name:'ZZ TEST foreign edit'})).status;
 rows.privateDeactivate=(await call('POST','/api/roles/'+privateRole+'/deactivate',b.cookie,{force:true})).status;
 rows.ownRoleRead=(await call('GET','/api/roles/'+bRole,b.cookie)).status;
 const listing=(await call('GET','/api/roles',b.cookie)).data;
 rows.roleListScoped=listing.some(role=>role.id===sharedRole)&&listing.some(role=>role.id===bRole)&&!listing.some(role=>role.id===privateRole);
 rows.sharedPatch=(await call('PATCH','/api/roles/'+sharedRole,b.cookie,{name:'ZZ TEST Shared Authoring',branchIds:[b.branch]})).status;
 const links=(await c.query('select branch_id from role_branch_assignments where role_id=$1',[sharedRole])).rows.map(row=>row.branch_id);
 rows.ownBranchesPreserved=links.includes(b.branch);rows.foreignBranchesPreserved=links.includes(a.branch);
 rows.sharedDeactivate=(await call('POST','/api/roles/'+sharedRole+'/deactivate',b.cookie,{force:true})).status;
 const created=await call('POST','/api/roles',b.cookie,{name:'ZZ TEST Shared Created',branchIds:[b.branch]});rows.sharedCreate=created.status;
 rows.defaultCreatePreserved=created.data?.tenantId===shared.tenant;
 const people=[];for(const label of ['foreign-user','own-user','bad-branches']){people.push((await c.query("insert into people(tenant_id,full_name,email,person_type) values($1,$2,$3,'ADVISOR') returning id",[b.tenant,'ZZ TEST Policy '+label,'zz-policy-'+label+'-'+randomUUID()+'@example.invalid'])).rows[0].id);}
 const policyBody={accessLevel:'STAFF',modules:{core:true,hr:false,studio:false,events:false,ops:false,setup:false},branchScope:'SELECTED',branchIds:[b.branch]};
 rows.policyForeignUser=(await call('POST','/api/data-admin/access-policies',b.cookie,{...policyBody,personId:people[0],coreUserId:a.id})).status;
 rows.policyOwnUser=(await call('POST','/api/data-admin/access-policies',b.cookie,{...policyBody,personId:people[1],coreUserId:b.id})).status;
 rows.policyMalformedBranches=(await call('POST','/api/data-admin/access-policies',b.cookie,{...policyBody,personId:people[2],branchIds:a.branch})).status;
 rows.overrideMalformedBranches=(await call('POST','/api/data-admin/user-module-overrides',b.cookie,{userId:b.id,moduleKey:'tasks',enabled:true,branchScopeType:'CUSTOM',branchIds:{foreign:a.branch}})).status;
 const privateAfter=(await c.query('select name,is_active from roles where id=$1',[privateRole])).rows[0];rows.privateUnchanged=privateAfter.name==='ZZ TEST Private Role A'&&privateAfter.is_active;
 console.log('ACCESS_CROSS_RESULTS='+JSON.stringify(rows));
} finally {if(server&&server.exitCode===null&&server.signalCode===null){await new Promise(resolve=>{server.once('exit',resolve);server.kill();});}await c.end();}
`,
      );
      const response = await run(
        process.execPath,
        [
          join(APP, 'node_modules/tsx/dist/cli.mjs'),
          '--tsconfig',
          join(APP, 'tsconfig.json'),
          script,
        ],
        {
          ...process.env,
          DATABASE_URL: database.url,
        },
        300_000,
      );
      expect(response.status, response.stderr).toBe(0);
      const payload = /ACCESS_CROSS_RESULTS=(.+)/.exec(response.stdout);
      expect(payload, response.stdout).toBeTruthy();
      result = JSON.parse(payload![1]!);
    } finally {
      await database.drop();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 500_000);

  it('the owned presence record remains readable through its custom primary key', () => {
    expect(result.presenceOwn).toBe(200);
  });
  it(
    'FINDING 1 (medium, fixed): another park’s presence record is refused; prescribed fix: apply rowScope in EmployeePresenceAdmin.getById',
    () => {
      expect(result.presenceForeign).toBe(404);
    },
  );
  it('private third-park role reads and metadata writes are refused, leaving its row unchanged', () => {
    expect([result.privateRead, result.privatePatch, result.privateDeactivate]).toEqual([
      404, 404, 404,
    ]);
    expect(result.privateUnchanged).toBe(true);
    expect(result.ownRoleRead).toBe(200);
    expect(result.roleListScoped).toBe(true);
  });
  it('Q54 default: shared authoring and own branch replacement preserve the shared dictionary and another park’s assignment', () => {
    expect([result.sharedRead, result.sharedPatch, result.sharedDeactivate]).toEqual([
      200, 200, 200,
    ]);
    expect(result.sharedCreate).toBe(201);
    expect(result.defaultCreatePreserved).toBe(true);
    expect(result.ownBranchesPreserved).toBe(true);
    expect(result.foreignBranchesPreserved).toBe(true);
  });
  it.fails(
    'Q54 (low, standing): only the owning park authors shared metadata; prescribed disposition: retain shared authoring until the owner chooses this alternative',
    () => {
      expect([result.sharedPatch, result.sharedDeactivate]).toEqual([404, 404]);
    },
  );
  it('an access policy can keep its own park’s soft user link and valid branch array', () => {
    expect(result.policyOwnUser).toBe(201);
  });
  it(
    'FINDING 2 (high, fixed): a policy cannot link another park’s user; prescribed fix: explicitly validate coreUserId despite its soft-link schema',
    () => {
      expect(result.policyForeignUser).toBe(404);
    },
  );
  it(
    'FINDING 3 (medium, fixed): malformed branch lists are refused; prescribed fix: validate supplied branchIds shape and each own-park parent before writing',
    () => {
      expect([400, 404]).toContain(result.policyMalformedBranches);
      expect([400, 404]).toContain(result.overrideMalformedBranches);
    },
  );
});
