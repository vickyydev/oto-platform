import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, stopTestServer } from '@oto/db/testing';

/** SCRUM-516: real manager handlers and PostgreSQL, prepared for hosted CI.
 * Preserves explicit actions, current branch access and effective-date behavior.
 * FINDING pins carry severity and prescribed changes; no local DB run is implied.
 */
const APP = fileURLToPath(new URL('../../oto-app/', import.meta.url));
const available = existsSync(join(APP, 'node_modules/tsx/dist/cli.mjs'));
let results: Record<string, boolean>;

it('FINDING 1 high, fixed: Employee history references stay in the app schema; prescribed fix: unqualified migration references', () => {
  const journal = JSON.parse(readFileSync(join(APP, 'migrations/meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
  const tag = journal.entries.find(entry => entry.tag.endsWith('_employee_action_receipts'))?.tag;
  expect(tag).toBeTruthy();
  expect(readFileSync(join(APP, `migrations/${tag}.sql`), 'utf8')).not.toMatch(/"public"\./);
});

describe.skipIf(!available)('Employee history release review', () => {
  afterAll(stopTestServer);
  beforeAll(async () => {
    const database = await createTestDatabase();
    const directory = mkdtempSync(join(tmpdir(), 'oto-employee-review-'));
    const env = { ...process.env, DATABASE_URL: database.url, DB_SCHEMA: 'otoapp',
      APP_ENV: 'dev', DEPLOY_ENV: 'local', OBJECT_STORAGE: 'local',
      STORAGE_ENV_PREFIX: 'zz-employee-history', OTOAPP_JOBS: 'platform', NODE_ENV: 'test', OTOAPP_LEGACY_LOGIN: 'true' };
    try {
      const migration = spawnSync(process.execPath, [join(APP, 'script/migrate.mjs')],
        { cwd: APP, env, encoding: 'utf8', timeout: 120_000 });
      expect(migration.status, 'App migration completes').toBe(0);
      const script = join(directory, 'employee.mts');
      writeFileSync(script, String.raw`
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
const app=${JSON.stringify(APP)};
const moduleUrl=path=>pathToFileURL(app+path).href;
let stage='imports';
const report=error=>{console.log('EMPLOYEE_SETUP_ERROR='+JSON.stringify({stage,name:error?.name,code:error?.code,column:error?.column,table:error?.table,constraint:error?.constraint}));process.exit(1);};
process.on('uncaughtException',report);process.on('unhandledRejection',report);
const require=createRequire(app+'package.json'),express=require('express'),pg=require('pg');
const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();await c.query('set search_path to otoapp');
const q=async(text,values=[])=>{stage='SQL '+text.split(/\s+/).slice(0,3).join(' ');return (await c.query(text,values)).rows;};
const {storage}=await import(moduleUrl('server/storage.ts'));
const {registerEmployeeActionRoutes}=await import(moduleUrl('server/employee-action-routes.ts'));
const api=express(),actors=new Map();api.use(express.json());
api.use((req,_res,next)=>{const actor=actors.get(req.headers['x-zz-test-actor']);req.isAuthenticated=()=>!!actor;req.user=actor;req.userWithAccess=actor;req.logout=cb=>cb();next();});
registerEmployeeActionRoutes(api,{attentionWritesReady:true,displayName:employee=>employee.fullName,reviewCommitted:()=>{}});
api.use((error,_req,res,_next)=>res.status(500).json({message:'ZZ TEST request failed',code:error?.code}));
let server;
try {
 const groups=[];
 for(const label of ['A','B']){
  const tenant=randomUUID(),user=randomUUID();
  await q('insert into tenants(id,name,slug) values($1,$2,$3)',[tenant,'ZZ TEST History '+label,'zz-sop-'+tenant]);
  const branch=(await q("insert into branches(tenant_id,name,address) values($1,$2,'ZZ TEST address') returning id",[tenant,'ZZ TEST Branch '+label]))[0].id;
  await q("insert into users(id,email,password,full_name,role) values($1,$2,'ZZ TEST unused credential',$3,'admin')",[user,user+'@zz-test.invalid','ZZ TEST Admin '+label]);
  await q("insert into user_branch_access(tenant_id,user_id,access_scope) values($1,$2,'all_branches')",[tenant,user]);
  actors.set(user,await storage.getUserWithBranchAccess(user));groups.push({tenant,user,branch});
 }
 const [a,b]=groups;
 const branch2=(await q("insert into branches(tenant_id,name,address) values($1,'ZZ TEST Branch A2','ZZ TEST address') returning id",[a.tenant]))[0].id;
 const limited=randomUUID(),staff=randomUUID(),secondAdmin=randomUUID();
 for(const [id,role] of [[limited,'operator_admin'],[staff,'staff'],[secondAdmin,'admin']]){
  await q("insert into users(id,email,password,full_name,role) values($1,$2,'ZZ TEST unused credential','ZZ TEST History Actor',$3)",[id,id+'@zz-test.invalid',role]);
  const row=await storage.getUser(id);
  actors.set(id,{...row,tenantId:a.tenant,allowedBranchIds:[a.branch],hasAllBranchesAccess:id===secondAdmin});
 }
 server=await new Promise(resolve=>{const s=api.listen(0,'127.0.0.1',()=>resolve(s));});
 const origin='http://127.0.0.1:'+server.address().port;
 const call=async(method,path,actor,body)=>{stage='HTTP '+method+' '+path.split('/').slice(0,3).join('/');const response=await fetch(origin+path,{method,headers:{...(actor?{'x-zz-test-actor':actor}:{}),...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});const text=await response.text();let data;try{data=JSON.parse(text);}catch{data=null;}return {status:response.status,data};};

 const rows={};
 const makeEmployee=async(group,branch=group.branch,user=null)=>(await q("insert into employees(tenant_id,full_name,nickname,email,branch_id,status,user_id,default_merge_data) values($1,'ZZ TEST Employee','ZZ TEST Name',$2,$3,'active',$4,$5) returning id",[group.tenant,randomUUID()+'@zz-test.invalid',branch,user,{positionTitle:'ZZ TEST Original',salaryThb:1000}]))[0].id;
 const e=await makeEmployee(a),foreign=await makeEmployee(b),second=await makeEmployee(a),hidden=await makeEmployee(a,branch2);
 const path='/api/employees/'+e;
 const count=async(table,id=e)=>(await q('select count(*)::int n from '+table+' where employee_id=$1',[id]))[0].n;
 const read=async(id=e)=>(await q('select * from employees where id=$1',[id]))[0];
 const terms={requestId:randomUUID(),changeType:'title_change',effectiveDate:'2020-01-01',newTitle:'ZZ TEST Supervisor'};
 const saved=await call('POST',path+'/changes',a.user,terms);
 const change=saved.data;
 rows.termActor=saved.status===201&&change.oldTitle==='ZZ TEST Original'&&change.newTitle==='ZZ TEST Supervisor'&&change.createdBy===a.user&&!!change.createdAt&&change.effectiveDate.startsWith('2020-01-01')&&(await read()).default_merge_data.positionTitle==='ZZ TEST Supervisor'&&await count('attention_items')===1&&await count('activity_log')===1;
 rows.termReplay=isDeepStrictEqual(await call('POST',path+'/changes',a.user,terms),saved)&&await count('employee_changes')===1&&await count('attention_items')===1;
 rows.changedReplay=(await call('POST',path+'/changes',a.user,{...terms,newTitle:'ZZ TEST Substitution'})).status===409&&(await call('POST',path+'/changes',a.user,{...terms,newIncentiveClause:null})).status===409&&(await call('POST',path+'/changes',secondAdmin,terms)).status===409&&(await call('POST','/api/employees/'+second+'/changes',a.user,terms)).status===409;
 const next=await call('POST',path+'/changes',a.user,{...terms,requestId:randomUUID()});
 rows.newDecision=next.status===201&&next.data.id!==change.id&&next.data.oldTitle==='ZZ TEST Supervisor'&&await count('employee_changes')===2;
 const concurrentBody={...terms,requestId:randomUUID(),newTitle:'ZZ TEST Concurrent'};
 const concurrent=await Promise.all([call('POST',path+'/changes',a.user,concurrentBody),call('POST',path+'/changes',a.user,concurrentBody)]);
 rows.concurrentRetry=concurrent[0].status===201&&isDeepStrictEqual(concurrent[0],concurrent[1])&&await count('employee_changes')===3;
 const explicit=await Promise.all(['One','Two'].map(label=>call('POST',path+'/changes',a.user,{...terms,requestId:randomUUID(),newTitle:'ZZ TEST '+label})));
 const history=await q("select old_title,new_title from employee_changes where employee_id=$1 and new_title in ('ZZ TEST One','ZZ TEST Two')",[e]);
 rows.concurrentDecisions=explicit.every(x=>x.status===201)&&history.length===2&&history.some(x=>x.old_title==='ZZ TEST Concurrent')&&history.some(x=>['ZZ TEST One','ZZ TEST Two'].includes(x.old_title));
 rows.sameParkBranch=(await call('POST','/api/employees/'+hidden+'/changes',limited,{...terms,requestId:randomUUID()})).status===201&&(await call('POST','/api/employees/'+hidden+'/complete-probation-review',limited,{requestId:randomUUID()})).status===200;
 actors.set('missing',{...actors.get(a.user),tenantId:undefined});
 rows.missingContext=(await call('POST',path+'/changes','missing',terms)).status===403&&(await call('PATCH',path+'/changes/'+change.id,'missing',{contractGenerated:true})).status===403;
 rows.roles=(await call('POST',path+'/complete-probation-review',staff,{})).status===403&&(await call('POST',path+'/changes',staff,terms)).status===403&&(await call('PATCH',path+'/changes/'+change.id,staff,{contractGenerated:true})).status===403&&(await call('POST',path+'/transfer',staff,{})).status===403&&(await call('POST',path+'/complete-probation-review',undefined,{})).status===401;
 rows.foreign=(await call('POST',path+'/changes',b.user,terms)).status===404&&(await call('POST',path+'/complete-probation-review',b.user,{})).status===404&&(await call('POST',path+'/transfer',b.user,{})).status===404&&(await call('PATCH',path+'/changes/'+change.id,b.user,{contractGenerated:true})).status===404;
 rows.historyMetadata=(await call('PATCH',path+'/changes/'+change.id,a.user,{createdBy:b.user,newTitle:'ZZ TEST Altered',createdAt:'2020-01-01'})).status===400&&(await call('PATCH','/api/employees/'+second+'/changes/'+change.id,a.user,{contractGenerated:true})).status===404;
 let immutable=false;try{await q("update employee_changes set note='ZZ TEST altered' where id=$1",[change.id]);}catch(error){immutable=error.code==='P0001';}rows.databaseHistory=immutable;
 const makeContract=async(employee,group)=>{const template=(await q("insert into templates(tenant_id,name,html_body) values($1,'ZZ TEST Contract','ZZ TEST Body') returning id",[group.tenant]))[0].id;return (await q("insert into contract_instances(employee_id,template_id,template_snapshot_html,template_snapshot_version,merge_data_json,created_by) values($1,$2,'ZZ TEST Body',1,'{}',$3) returning id",[employee,template,group.user]))[0].id;};
 const contract=await makeContract(e,a),otherContract=await makeContract(second,a),foreignContract=await makeContract(foreign,b);
 rows.contractScope=(await call('PATCH',path+'/changes/'+change.id,a.user,{contractGenerated:true,contractInstanceId:otherContract})).status===404&&(await call('PATCH',path+'/changes/'+change.id,a.user,{contractGenerated:true,contractInstanceId:foreignContract})).status===404;
 const marked=await call('PATCH',path+'/changes/'+change.id,a.user,{contractGenerated:true,contractInstanceId:contract});
 rows.contractMark=marked.status===200&&marked.data.contractInstanceId===contract&&marked.data.createdAt===change.createdAt&&marked.data.createdBy===a.user&&marked.data.newTitle===change.newTitle&&isDeepStrictEqual(await call('PATCH',path+'/changes/'+change.id,a.user,{contractGenerated:true,contractInstanceId:contract}),marked);
 await q("insert into attention_items(tenant_id,employee_id,branch_id,type,severity,title) values($1,$2,$3,'PROBATION_REVIEW_OVERDUE','medium','ZZ TEST Review')",[a.tenant,e,a.branch]);
 const complete={requestId:randomUUID()},review=await call('POST',path+'/complete-probation-review',a.user,complete);
 rows.reviewAtomic=review.status===200&&!!review.data.probationReviewCompletedAt&&(await q("select count(*)::int n from attention_items where employee_id=$1 and type='PROBATION_REVIEW_OVERDUE'",[e]))[0].n===0;
 rows.reviewReplay=isDeepStrictEqual(await call('POST',path+'/complete-probation-review',a.user,complete),review)&&(await q("select count(*)::int n from activity_log where employee_id=$1 and activity_type='probation_completed'",[e]))[0].n===1;
 rows.newReview=(await call('POST',path+'/complete-probation-review',a.user,{requestId:randomUUID()})).status===200&&(await q("select count(*)::int n from activity_log where employee_id=$1 and activity_type='probation_completed'",[e]))[0].n===2;
 await q("create function zz_employee_fail() returns trigger language plpgsql as $$ begin raise exception 'ZZ TEST injected'; end $$");
 await q('create trigger zz_employee_fail before insert on activity_log for each row execute function zz_employee_fail()');
 const before=await read(),beforeHistory=await count('employee_changes'),beforeReceipts=await count('employee_action_receipts');
 const failTerm=await call('POST',path+'/changes',a.user,{...terms,requestId:randomUUID(),newTitle:'ZZ TEST Rollback'});
 const failReview=await call('POST',path+'/complete-probation-review',a.user,{requestId:randomUUID()});
 await q('drop trigger zz_employee_fail on activity_log');
 rows.actionRollback=failTerm.status===500&&failReview.status===500&&isDeepStrictEqual(await read(),before)&&await count('employee_changes')===beforeHistory&&await count('employee_action_receipts')===beforeReceipts;
 const linked=randomUUID();await q("insert into users(id,email,password,full_name,role) values($1,$2,'ZZ TEST unused credential','ZZ TEST Linked','staff')",[linked,linked+'@zz-test.invalid']);await q("insert into user_branch_access(tenant_id,user_id,access_scope,branch_id) values($1,$2,'selected_branches',$3)",[a.tenant,linked,a.branch]);
 const moving=await makeEmployee(a,a.branch,linked),movingPath='/api/employees/'+moving;
 const dateAt=days=>{const d=new Date();d.setUTCDate(d.getUTCDate()+days);return d.toISOString().split('T')[0];},effective=dateAt(3),past=dateAt(1),far=dateAt(800);
 const week=(await q('insert into schedule_week_plans(tenant_id,branch_id,week_start_date) values($1,$2,$3) returning id',[a.tenant,a.branch,effective]))[0].id;
 const group=(await q("insert into shift_groups(tenant_id,branch_id,name) values($1,$2,'ZZ TEST Group') returning id",[a.tenant,a.branch]))[0].id;
 const shift=(await q("insert into schedule_shift_rows(tenant_id,branch_id,shift_group_id,start_time,end_time) values($1,$2,$3,'09:00','17:00') returning id",[a.tenant,a.branch,group]))[0].id;
 for(const day of [past,effective,far])await q('insert into schedule_assignments(tenant_id,week_plan_id,shift_row_id,employee_id,shift_date) values($1,$2,$3,$4,$5)',[a.tenant,week,shift,moving,day]);
 for(const [branch,day] of [[a.branch,past],[a.branch,effective],[a.branch,far],[branch2,effective]])await q("insert into employee_time_off(tenant_id,employee_id,branch_id,type,start_date,end_date,created_by) values($1,$2,$3,'LEAVE',$4,$4,$5)",[a.tenant,moving,branch,day,a.user]);
 const transfer={requestId:randomUUID(),effectiveDate:effective,newBranchId:branch2,note:'ZZ TEST Move'};
 rows.transferBoundaries=(await call('POST',movingPath+'/transfer',limited,transfer)).status===403&&(await call('POST',movingPath+'/transfer',a.user,{...transfer,newBranchId:b.branch})).status===400;
 await q('create trigger zz_employee_fail before insert on attention_items for each row execute function zz_employee_fail()');
 const failedTransfer=await call('POST',movingPath+'/transfer',a.user,transfer);
 await q('drop trigger zz_employee_fail on attention_items');
 rows.transferRollback=failedTransfer.status===500&&(await read(moving)).branch_id===a.branch&&await count('employee_changes',moving)===0&&await count('schedule_assignments',moving)===3&&await count('employee_time_off',moving)===4&&(await q('select branch_id from user_branch_access where user_id=$1',[linked]))[0].branch_id===a.branch&&await count('activity_log',moving)===0;
 const concurrentTransfers=await Promise.all([call('POST',movingPath+'/transfer',a.user,transfer),call('POST',movingPath+'/transfer',a.user,transfer)]);
 const moved=concurrentTransfers[0];
 rows.transferConcurrent=moved.status===200&&isDeepStrictEqual(moved,concurrentTransfers[1]);
 rows.transferEffects=moved.status===200&&moved.data.deletedAssignments===1&&moved.data.deletedTimeOff===2&&(await read(moving)).branch_id===branch2&&await count('schedule_assignments',moving)===2&&await count('employee_time_off',moving)===2&&await count('employee_changes',moving)===1&&await count('activity_log',moving)===1&&await count('attention_items',moving)===1&&(await q('select branch_id from user_branch_access where user_id=$1',[linked]))[0].branch_id===branch2;
 rows.transferReplay=isDeepStrictEqual(await call('POST',movingPath+'/transfer',a.user,transfer),moved)&&await count('employee_changes',moving)===1;
 rows.transferNewDecision=(await call('POST',movingPath+'/transfer',a.user,{...transfer,requestId:randomUUID()})).status===400;
 const initialActor=actors.get(a.user);actors.set(a.user,{...initialActor,hasAllBranchesAccess:false,allowedBranchIds:[branch2]});rows.transferReplayScope=(await call('POST',movingPath+'/transfer',a.user,transfer)).status===403;actors.set(a.user,initialActor);
 rows.legacy=(await call('POST',path+'/changes',a.user,{...terms,requestId:undefined})).status===201&&(await call('POST',path+'/complete-probation-review',a.user,{})).status===200;
 rows.invalidId=(await call('POST',path+'/changes',a.user,{...terms,requestId:'invalid'})).status===400;
 console.log('EMPLOYEE_RESULTS='+JSON.stringify(rows));
} finally {if(server)await new Promise(resolve=>server.close(resolve));await c.end();const {pool}=await import(moduleUrl('server/db.ts'));await pool.end();}
process.exit(0);
`);
      const run = spawnSync(process.execPath, [join(APP, 'node_modules/tsx/dist/cli.mjs'), '--tsconfig', join(APP, 'tsconfig.json'), script],
        { cwd: APP, env, encoding: 'utf8', timeout: 240_000 });
      const match = /EMPLOYEE_RESULTS=(.+)/.exec(run.stdout ?? '');
      if (run.status !== 0) {
        const output = (run.stdout ?? '') + (run.stderr ?? '');
        console.info('Employee review setup', /EMPLOYEE_SETUP_ERROR=(.+)/.exec(output)?.[1] ?? 'No result marker');
        console.info('Employee review frames', [...output.matchAll(/[A-Za-z0-9_-]+\.(?:ts|mts|js|mjs):\d+:\d+/g)].map(x => x[0]));
      }
      expect(run.status, 'Employee child completes').toBe(0);
      expect(match, 'Employee result recorded').toBeTruthy();
      results = JSON.parse(match![1]!);
    } finally {
      await database.drop();
      const absolute = resolve(directory), bound = relative(resolve(tmpdir()), absolute);
      expect(!isAbsolute(bound) && !bound.startsWith('..') && bound.startsWith('oto-employee-review-')).toBe(true);
      rmSync(absolute, { recursive: true, force: true });
    }
  }, 420_000);

  it('terms retain before/after values, actor, date, activity and contract prompt', () => expect(results.termActor).toBe(true));
  it('FINDING 2 high: retries save one terms action; prescribed fix: scoped receipt and employee lock', () => expect(results.termReplay).toBe(true));
  it('another actor, employee or changed payload cannot reuse a receipt', () => expect(results.changedReplay).toBe(true));
  it('a new explicit terms decision creates its own history', () => expect(results.newDecision).toBe(true));
  it('concurrent retries return one committed response', () => expect(results.concurrentRetry).toBe(true));
  it('concurrent distinct actions read serialized current values', () => expect(results.concurrentDecisions).toBe(true));
  it('same-park completion and terms retain their existing branch behavior', () => expect(results.sameParkBranch).toBe(true));
  it('resolved park context is required before employee writes', () => expect(results.missingContext).toBe(true));
  it('manager-only actions reject staff and signed-out callers', () => expect(results.roles).toBe(true));
  it('another park cannot complete, update, mark or transfer this employee', () => expect(results.foreign).toBe(true));
  it('FINDING 3 high: original history fields are protected; prescribed fix: strict contract-field allowlist and parent fence', () => expect(results.historyMetadata).toBe(true));
  it('stored history metadata remains immutable', () => expect(results.databaseHistory).toBe(true));
  it('FINDING 4 high: contract links stay with their employee and park; prescribed fix: validate linked contract ownership', () => expect(results.contractScope).toBe(true));
  it('contract marking preserves original actor, time and before/after values and safely repeats', () => expect(results.contractMark).toBe(true));
  it('review completion clears due attention in the same action', () => expect(results.reviewAtomic).toBe(true));
  it('FINDING 5 medium: completion retry keeps its first date and activity; prescribed fix: explicit action receipt', () => expect(results.reviewReplay).toBe(true));
  it('a new explicit completion action has its own history', () => expect(results.newReview).toBe(true));
  it('FINDING 6 high: late activity failure leaves terms and completion unchanged; prescribed fix: transaction across related effects', () => expect(results.actionRollback).toBe(true));
  it('transfer requires both branches and its own park destination', () => expect(results.transferBoundaries).toBe(true));
  it('FINDING 7 high: late transfer failure preserves employee, history, schedules, leave and access; prescribed fix: one transaction', () => expect(results.transferRollback).toBe(true));
  it('transfer applies immediately and retains the existing schedule year and old-branch leave ranges', () => expect(results.transferEffects).toBe(true));
  it('concurrent transfer retries preserve the first cleanup counts', () => expect(results.transferConcurrent).toBe(true));
  it('transfer retry returns its original cleanup counts and history', () => expect(results.transferReplay).toBe(true));
  it('a new unchanged transfer retains its existing no-change answer', () => expect(results.transferNewDecision).toBe(true));
  it('transfer receipts recheck original and destination branch access', () => expect(results.transferReplayScope).toBe(true));
  it('existing callers without request IDs continue to work', () => expect(results.legacy).toBe(true));
  it('malformed request IDs are refused', () => expect(results.invalidId).toBe(true));
});
