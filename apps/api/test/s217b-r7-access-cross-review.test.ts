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
  overrideFailureReached: boolean;
  overrideFailureRetained: boolean;
  overrideRaceReached: boolean;
  overrideRaceWholeSet: boolean;
  overrideClearWorks: boolean;
  privatePhotoControl: boolean;
  externalPhotoControl: boolean;
  privatePhotoVariantsRefused: boolean;
  privatePhotoBytesRefused: boolean;
  privatePhotoWriteStatuses: number[];
  privatePhotoBorrowedBytes: boolean[];
  overrideReaderControl: boolean;
  overrideOwnChoicePreserved: boolean;
  overrideForeignChoiceIgnored: boolean;
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
import {createServer} from 'node:http';
import {unlinkSync} from 'node:fs';
import {basename,resolve} from 'node:path';
import {createRequire} from 'node:module';
const app=${JSON.stringify(APP)};
const require=createRequire(app+'package.json');const pg=require('pg');
const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();await c.query('set search_path to otoapp');
const password=randomBytes(24).toString('hex'),salt=randomBytes(16).toString('hex');const hash=scryptSync(password,salt,64).toString('hex')+'.'+salt;
const groups=[];const rows={};let server;let origin;let publicServer;let uploadedFile;
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
 // A replacement refusal must leave the saved selection intact.
 await c.query('delete from user_module_overrides where tenant_id=$1 and user_id=$2',[a.tenant,a.id]);
 await c.query("insert into user_module_overrides(tenant_id,user_id,module_key,enabled,branch_scope_type,branch_ids) values($1,$2,'tasks',false,'CUSTOM',$3)",[a.tenant,a.id,JSON.stringify([a.branch])]);
 const prior=(await call('GET','/api/module-overrides/'+a.id,a.cookie)).data;
 assert.equal(prior.length,1);assert.equal(prior[0].enabled,false);
 await c.query("create function zz_test_override_barrier() returns trigger language plpgsql as $$ begin if NEW.notes='ZZ TEST fail override' then raise exception 'ZZ TEST override insert refusal'; end if; if NEW.notes in ('ZZ TEST race one','ZZ TEST race two') then perform pg_advisory_xact_lock(884412); end if; return NEW; end $$");
 await c.query('create trigger zz_test_override_barrier before insert on user_module_overrides for each row execute function zz_test_override_barrier()');
 const refused=await call('PUT','/api/module-overrides/'+a.id,a.cookie,{overrides:[{moduleKey:'tasks',enabled:true,branchScopeType:'CUSTOM',branchIds:[a.branch],notes:'ZZ TEST fail override'}]});
 rows.overrideFailureReached=refused.status===500;
 const afterRefusal=(await call('GET','/api/module-overrides/'+a.id,a.cookie)).data;
 rows.overrideFailureRetained=afterRefusal.length===1&&afterRefusal[0].id===prior[0].id&&afterRefusal[0].enabled===false;
 // Start empty and block both requests before their disjoint inserts finish.
 const clearResponse=await call('DELETE','/api/module-overrides/'+a.id,a.cookie);
 rows.overrideClearWorks=clearResponse.status===200&&(await call('GET','/api/module-overrides/'+a.id,a.cookie)).data.length===0;
 await c.query('select pg_advisory_lock(884412)');
 const replaceOne=call('PUT','/api/module-overrides/'+a.id,a.cookie,{overrides:[{moduleKey:'tasks',enabled:true,branchScopeType:'CUSTOM',branchIds:[a.branch],notes:'ZZ TEST race one'}]});
 const replaceTwo=call('PUT','/api/module-overrides/'+a.id,a.cookie,{overrides:[{moduleKey:'events',enabled:true,branchScopeType:'CUSTOM',branchIds:[a.branch],notes:'ZZ TEST race two'}]});
 let barrier=false;for(let n=0;n<750;n++){const waiting=Number((await c.query("select count(*) as n from pg_locks where locktype='advisory' and not granted and database=(select oid from pg_database where datname=current_database())")).rows[0].n);if(waiting>=2){barrier=true;break;}await new Promise(resolve=>setTimeout(resolve,20));}
 await c.query('select pg_advisory_unlock(884412)');
 const replacements=await Promise.all([replaceOne,replaceTwo]);
 rows.overrideRaceReached=barrier&&replacements.every(response=>response.status===200);
 const finalChoices=(await call('GET','/api/module-overrides/'+a.id,a.cookie)).data;
 rows.overrideRaceWholeSet=finalChoices.length===1&&['tasks','events'].includes(finalChoices[0].moduleKey)&&finalChoices[0].enabled===true;
 await c.query('drop trigger zz_test_override_barrier on user_module_overrides');await c.query('drop function zz_test_override_barrier()');
 // Exercise a real owned object through its writer and every read gate.
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlZtSAAAAAASUVORK5CYII=','base64');
 const upload=new FormData();upload.append('photo',new Blob([png],{type:'image/png'}),'ZZ TEST private photo.png');
 const uploadResponse=await fetch(origin+'/api/employees/'+employee+'/profile-photo',{method:'POST',headers:{cookie:a.cookie},body:upload});
 assert.equal(uploadResponse.status,200);const photoPath=(await uploadResponse.json()).profilePhotoPath;
 const filename=basename(photoPath);assert.match(filename,/^profile_[a-zA-Z0-9-]+_[0-9]+\\.jpg$/);
 uploadedFile=resolve(app,'uploads','profile-photos',filename);
 assert.ok(uploadedFile.startsWith(resolve(app,'uploads','profile-photos')+'/')||uploadedFile.startsWith(resolve(app,'uploads','profile-photos')+'\\\\'));
 const ownPhoto=await fetch(origin+'/api/employees/'+employee+'/profile-photo',{headers:{cookie:a.cookie}});
 const foreignPhoto=await fetch(origin+photoPath,{headers:{cookie:b.cookie}});
 rows.privatePhotoControl=ownPhoto.status===200&&Buffer.from(await ownPhoto.arrayBuffer()).equals(png)&&foreignPhoto.status===404;
 const bEmployee=(await c.query("insert into employees(tenant_id,branch_id,full_name,nickname,email) values($1,$2,'ZZ TEST Media Employee B','ZZ TEST Media B',$3) returning id",[b.tenant,b.branch,'zz-media-'+randomUUID()+'@example.invalid'])).rows[0].id;
 const publicImage=Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64');
 publicServer=createServer((_request,response)=>{response.writeHead(200,{'content-type':'image/gif'});response.end(publicImage);});
 await new Promise(resolve=>publicServer.listen(0,'127.0.0.1',resolve));
 const external='http://127.0.0.1:'+publicServer.address().port+'/public/ZZ-TEST-profile.png';
 const externalWrite=await call('PUT','/api/data-admin/employees/'+bEmployee,b.cookie,{profilePhotoPath:external});
 const externalRow=await call('GET','/api/data-admin/employees/'+bEmployee,b.cookie);const externalRead=await fetch(external);
 rows.externalPhotoControl=externalWrite.status===200&&externalRow.data.profilePhotoPath===external&&externalRead.status===200&&Buffer.from(await externalRead.arrayBuffer()).equals(publicImage);
 const variants=[origin+photoPath,origin+'/%61pi/files/profile-photos/'+filename,origin+'/%2561pi/files/profile-photos/'+filename,origin+'/%61pi/files/employee-documents/'+filename];
 const mediaResults=[];
 for(const variant of variants){
  await c.query('update employees set profile_photo_path=$1 where id=$2',[external,bEmployee]);
  const writer=await call('PUT','/api/data-admin/employees/'+bEmployee,b.cookie,{profilePhotoPath:variant});
  const stored=(await call('GET','/api/data-admin/employees/'+bEmployee,b.cookie)).data.profilePhotoPath;
  const reader=await fetch(origin+'/api/employees/'+bEmployee+'/profile-photo',{headers:{cookie:b.cookie}});
  const bytes=Buffer.from(await reader.arrayBuffer());
  mediaResults.push({status:writer.status,refused:writer.status===409&&stored===external,privateBytes:reader.status===200&&bytes.equals(png)});
 }
 rows.privatePhotoWriteStatuses=mediaResults.map(row=>row.status);rows.privatePhotoBorrowedBytes=mediaResults.map(row=>row.privateBytes);
 rows.privatePhotoVariantsRefused=mediaResults.every(row=>row.refused);
 // A genuine public link with the same basename must still resolve publicly.
 const matchingPublic='http://127.0.0.1:'+publicServer.address().port+'/public/'+filename;
 const matchingWrite=await call('PUT','/api/data-admin/employees/'+bEmployee,b.cookie,{profilePhotoPath:matchingPublic});
 const matchingPublicRead=await fetch(matchingPublic);
 rows.externalPhotoControl=rows.externalPhotoControl&&matchingWrite.status===200&&matchingPublicRead.status===200&&Buffer.from(await matchingPublicRead.arrayBuffer()).equals(publicImage);
 const matchingPrivateRead=await fetch(origin+'/api/employees/'+bEmployee+'/profile-photo',{headers:{cookie:b.cookie}});
 const matchingPrivateBytes=matchingPrivateRead.status===200&&Buffer.from(await matchingPrivateRead.arrayBuffer()).equals(png);
 rows.privatePhotoBorrowedBytes.push(matchingPrivateBytes);
 rows.privatePhotoBytesRefused=mediaResults.every(row=>!row.privateBytes)&&!matchingPrivateBytes;
 // Historical foreign tenant rows must not govern either active reader.
 // operator_admin preserves full defaults while honoring explicit overrides.
 await c.query("update users set role='operator_admin' where id=$1",[a.id]);
 await c.query('delete from user_module_overrides where user_id=$1',[a.id]);
 const defaultPermissions=await call('GET','/api/permissions/me',a.cookie);
 const defaultGate=await call('POST','/api/settings',a.cookie,[]);
 rows.overrideReaderControl=defaultPermissions.status===200&&defaultPermissions.data.modules.find(module=>module.moduleKey==='settings').allowed===true&&defaultGate.status===200;
 await c.query("insert into user_module_overrides(tenant_id,user_id,module_key,enabled,branch_scope_type) values($1,$2,'settings',false,'ALL')",[a.tenant,a.id]);
 const ownPermissions=await call('GET','/api/permissions/me',a.cookie);const ownGate=await call('POST','/api/settings',a.cookie,[]);
 rows.overrideOwnChoicePreserved=ownPermissions.data.modules.find(module=>module.moduleKey==='settings').allowed===false&&ownGate.status===403;
 await c.query('delete from user_module_overrides where user_id=$1',[a.id]);
 await c.query("insert into user_module_overrides(tenant_id,user_id,module_key,enabled,branch_scope_type) values($1,$2,'settings',false,'ALL')",[b.tenant,a.id]);
 const foreignPermissions=await call('GET','/api/permissions/me',a.cookie);const foreignGate=await call('POST','/api/settings',a.cookie,[]);
 rows.overrideForeignChoiceIgnored=foreignPermissions.data.modules.find(module=>module.moduleKey==='settings').allowed===true&&foreignGate.status===200;
 const privateAfter=(await c.query('select name,is_active from roles where id=$1',[privateRole])).rows[0];rows.privateUnchanged=privateAfter.name==='ZZ TEST Private Role A'&&privateAfter.is_active;
 console.log('ACCESS_CROSS_RESULTS='+JSON.stringify(rows));
} finally {if(publicServer){await new Promise(resolve=>publicServer.close(resolve));}if(server&&server.exitCode===null&&server.signalCode===null){await new Promise(resolve=>{server.once('exit',resolve);server.kill();});}if(uploadedFile){unlinkSync(uploadedFile);}await c.end();}
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
      console.info('ZZ TEST private-media controls', JSON.stringify({
        writeStatuses: result.privatePhotoWriteStatuses,
        borrowedBytes: result.privatePhotoBorrowedBytes,
      }));
    } finally {
      await database.drop();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 500_000);

  it('the owned presence record remains readable through its custom primary key', () => {
    expect(result.presenceOwn).toBe(200);
  });
  it('FINDING 1 (medium, fixed): another park’s presence record is refused; prescribed fix: apply rowScope in EmployeePresenceAdmin.getById', () => {
    expect(result.presenceForeign).toBe(404);
  });
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
  it('FINDING 2 (high, fixed): a policy cannot link another park’s user; prescribed fix: explicitly validate coreUserId despite its soft-link schema', () => {
    expect(result.policyForeignUser).toBe(404);
  });
  it('FINDING 3 (medium, fixed): malformed branch lists are refused; prescribed fix: validate supplied branchIds shape and each own-park parent before writing', () => {
    expect([400, 404]).toContain(result.policyMalformedBranches);
    expect([400, 404]).toContain(result.overrideMalformedBranches);
  });
  it('override failure and disjoint replacement controls reach their intended database boundaries', () => {
    expect(result.overrideFailureReached).toBe(true);
    expect(result.overrideRaceReached).toBe(true);
    expect(result.overrideClearWorks).toBe(true);
  });
  it(
    'FINDING 4 (medium, fixed): a refused replacement retains the prior choices; prescribed fix: delete and insert overrides on one transaction connection',
    () => {
      expect(result.overrideFailureRetained).toBe(true);
    },
  );
  it(
    'FINDING 5 (medium, fixed): concurrent empty-set replacements remain one whole selection; prescribed fix: serialize per user and park before deleting and inserting',
    () => {
      expect(result.overrideRaceWholeSet).toBe(true);
    },
  );
  it('a real owned photo is readable, its direct foreign alias is refused, and a public external image remains usable', () => {
    expect(result.privatePhotoControl).toBe(true);
    expect(result.externalPhotoControl).toBe(true);
  });
  it.fails('FINDING 6 (high): encoded app-private photo URLs cannot copy another park\u2019s object into an owned record; prescribed fix: decode private path segments before allowing external links and hold profile reads to approved object references', () => {
    expect(result.privatePhotoVariantsRefused).toBe(true);
    expect(result.privatePhotoBytesRefused).toBe(true);
  });
  it('module readers preserve role defaults and an owned explicit choice', () => {
    expect(result.overrideReaderControl).toBe(true);
    expect(result.overrideOwnChoicePreserved).toBe(true);
  });
  it.fails('FINDING 7 (high): historical overrides from another park cannot govern either module reader; prescribed fix: require the resolved park group in the getter and all four consumers', () => {
    expect(result.overrideForeignChoiceIgnored).toBe(true);
  });
});
