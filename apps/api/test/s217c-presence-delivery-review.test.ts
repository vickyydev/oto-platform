import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase } from '@oto/db/testing';
import { selectPresenceDelivery, type LocalPresenceDelivery } from '../../oto-app/client/src/lib/presence-delivery';

/**
 * SCRUM-521: actual delivery handler, database transactions and staff inbox.
 * FINDING 1 (high, fixed): replay or a process interruption can repeat a
 * message. Prescribed fix: durable key, payload fingerprint, row lock and
 * inbox/result in one transaction, with the original key used by Retry.
 * FINDING 2 (high, fixed): a linked login can belong to another park.
 * Prescribed fix: strict existing login placement and active account check.
 * FINDING 3 (medium, fixed): a notification write may fail after Pending.
 * Prescribed fix: durable Failed state and safe retry; never report Delivered
 * before the inbox row commits. Read/unread is a separate staff action.
 * FINDING 4 (medium, fixed): browser/server clock differences can hide an
 * unconfirmed attempt and mint a second request. Prescribed fix: retain the
 * unconfirmed key until its response or matching Delivered result arrives.
 */
const APP = fileURLToPath(new URL('../../oto-app/', import.meta.url));
const available = existsSync(join(APP, 'node_modules/tsx/dist/cli.mjs'));
let proof: Record<string, boolean>;

function removeFixture(directory: string) {
  const local = relative(tmpdir(), directory);
  if (!local.startsWith('oto-presence-review-') || local.includes('..') || isAbsolute(local)) throw new Error('Temporary cleanup boundary');
  rmSync(directory, { recursive: true, force: true });
}

describe.skipIf(!available)('Presence inbox delivery review', () => {
  beforeAll(async () => {
    const database = await createTestDatabase();
    const directory = mkdtempSync(join(tmpdir(), 'oto-presence-review-'));
    try {
      const script = join(directory, 'delivery.mts');
      writeFileSync(script, String.raw`
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {readFileSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
const appPath=${JSON.stringify(APP)};
const require=createRequire(appPath+'package.json');
const express=require('express'),pg=require('pg'),ts=require('typescript');
const {drizzle}=require('drizzle-orm/node-postgres');
const {migrate}=require('drizzle-orm/node-postgres/migrator');
const {eq,and,inArray,desc,sql}=require('drizzle-orm');
const {registerPresenceNotificationDelivery,readPresenceDeliveries}=await import(pathToFileURL(appPath+'server/presence-notification-delivery.ts').href);
const schema=await import(pathToFileURL(appPath+'shared/schema.ts').href);
const {notifications}=await import(pathToFileURL(appPath+'server/db/coreSchema.ts').href);
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path=otoapp',max:10});
const db=drizzle(pool);let server;const proof={};
try {
 await migrate(db,{migrationsFolder:appPath+'migrations',migrationsSchema:'otoapp'});
 const groups=[];
 for(const label of ['A','B']) {
  const tenant=randomUUID(),branch=randomUUID(),group=randomUUID(),shift=randomUUID(),manager=randomUUID(),staff=randomUUID(),employee=randomUUID();
  await pool.query('insert into tenants(id,name,slug) values($1,$2,$3)',[tenant,'ZZ TEST '+label,'zz-'+tenant]);
  await pool.query('insert into branches(id,tenant_id,name,address) values($1,$2,$3,$4)',[branch,tenant,'ZZ TEST '+label,'ZZ'+label]);
  for(const [id,role] of [[manager,'manager'],[staff,'staff']]) {
   await pool.query("insert into users(id,email,password,full_name,role) values($1,$2,'ZZ TEST unused credential',$3,$4)",[id,id+'@zz-test.invalid','ZZ TEST '+role,role]);
   await pool.query('insert into user_branch_access(tenant_id,user_id,branch_id) values($1,$2,$3)',[tenant,id,branch]);
  }
  await pool.query("insert into employees(id,tenant_id,full_name,nickname,email,user_id,branch_id,status) values($1,$2,'ZZ TEST Staff','ZZ TEST',$3,$4,$5,'active')",[employee,tenant,randomUUID()+'@zz-test.invalid',staff,branch]);
  await pool.query("insert into shift_groups(id,tenant_id,branch_id,name) values($1,$2,$3,'ZZ TEST Group')",[group,tenant,branch]);
  await pool.query("insert into schedule_shift_rows(id,tenant_id,branch_id,shift_group_id,start_time,end_time) values($1,$2,$3,$4,'08:00','18:00')",[shift,tenant,branch,group]);
  groups.push({tenant,branch,group,shift,manager,staff,employee});
 }
 const [a,b]=groups;
 const branch2=randomUUID(),group2=randomUUID(),shift2=randomUUID();
 await pool.query("insert into branches(id,tenant_id,name,address) values($1,$2,'ZZ TEST A2','ZZA2')",[branch2,a.tenant]);
 await pool.query("insert into shift_groups(id,tenant_id,branch_id,name) values($1,$2,$3,'ZZ TEST Group A2')",[group2,a.tenant,branch2]);
 await pool.query("insert into schedule_shift_rows(id,tenant_id,branch_id,shift_group_id,start_time,end_time) values($1,$2,$3,$4,'08:00','18:00')",[shift2,a.tenant,branch2,group2]);
 const routes=readFileSync(appPath+'server/routes.ts','utf8');
 const placementSource=routes.slice(routes.indexOf('  const managedUserTenant ='),routes.indexOf('  const userManagementTenant ='));
 const placementJs=ts.transpileModule(placementSource,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const storage={getUserBranchAccess:async id=>(await db.select().from(schema.userBranchAccess).where(eq(schema.userBranchAccess.userId,id))),getUser:async id=>(await db.select().from(schema.users).where(eq(schema.users.id,id)))[0]};
 const placement=new Function('storage','db','eq','and','inArray','branches','operators','tenants',placementJs+';return managedUserTenant;')(storage,db,eq,and,inArray,schema.branches,schema.operators,schema.tenants);
 const app=express();app.use(express.json());
 app.use((req,_res,next)=>{const who=req.headers['x-test-actor'];const g=who==='b'?b:a;const staff=who==='staff'||who==='foreignStaff';req.user=who?{id:who==='foreignStaff'?b.staff:staff?g.staff:g.manager,role:staff?'staff':'manager'}:undefined;req.userWithAccess=who==='missing'?undefined:{tenantId:who==='foreignStaff'?b.tenant:g.tenant,hasAllBranchesAccess:who!=='restricted',allowedBranchIds:[g.branch]};next();});
 const auth=(req,res,next)=>req.user?next():res.status(401).json({message:'Sign in required'});
 const manager=(req,res,next)=>req.user.role==='manager'?next():res.status(403).json({message:'Manager access required'});
 registerPresenceNotificationDelivery(app,db,auth,manager,placement);
 const inboxStart=routes.indexOf('  app.get("/api/notifications",');const inboxEnd=routes.indexOf('  // General error handler',inboxStart);
 new Function('app','db','notificationsTable','requireAuth','eq','and','drizzleDesc','sql',routes.slice(inboxStart,inboxEnd))(app,db,notifications,auth,eq,and,desc,sql);
 app.use((_err,_req,res,_next)=>res.status(500).json({message:'Delivery request failed'}));
 server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});const origin='http://127.0.0.1:'+server.address().port;
 const request=async(method,path,body,actor='a')=>{const r=await fetch(origin+path,{method,headers:{'content-type':'application/json',...(actor?{'x-test-actor':actor}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});return {status:r.status,body:await r.json()};};
 const body={requestKey:randomUUID(),employeeId:a.employee,shiftRowId:a.shift,shiftDate:'2099-10-13',reason:'missing_clock_in'};
 const send=(value=body,actor='a')=>request('POST','/api/timekeeping/live/ping',value,actor);
 const count=async()=>Number((await pool.query('select count(*) n from notifications')).rows[0].n);
 const firstBatch=await Promise.all(Array.from({length:12},()=>send()));const delivered=firstBatch[0];proof.delivery=delivered.status===200&&delivered.body.delivery?.status==='Delivered'&&(await count())===1;
 const replay=await send();proof.replay=replay.body.delivery?.status==='Delivered'&&firstBatch.every(r=>r.body.delivery?.status==='Delivered')&&(await count())===1;
 proof.changed=(await send({...body,shiftDate:'2099-10-14'})).status===409&&(await count())===1;
 const beforeAttempts=Number((await pool.query('select count(*) n from presence_notification_deliveries')).rows[0].n);
 proof.fences=(await send({...body,requestKey:randomUUID()},'b')).status===404&&(await send({...body,requestKey:randomUUID(),shiftRowId:b.shift})).status===404&&(await send({...body,requestKey:randomUUID(),shiftRowId:shift2},'restricted')).status===403&&(await send(body,'staff')).status===403&&(await send(body,'')).status===401&&(await send(body,'missing')).status===403;
 proof.noRefusedWrites=beforeAttempts===Number((await pool.query('select count(*) n from presence_notification_deliveries')).rows[0].n);
 const inbox=await request('GET','/api/notifications',undefined,'staff');const notification=inbox.body[0];
 proof.inbox=inbox.status===200&&inbox.body.length===1&&notification.type==='timekeeping_ping'&&!notification.isRead;
 proof.privateInbox=(await request('GET','/api/notifications',undefined,'foreignStaff')).body.length===0&&(await request('PATCH','/api/notifications/'+notification.id+'/read',undefined,'foreignStaff')).status===404;
 proof.readSeparate=(await request('PATCH','/api/notifications/'+notification.id+'/read',undefined,'staff')).status===200&&(await request('GET','/api/notifications',undefined,'staff')).body[0].isRead&&(await send()).body.delivery.status==='Delivered';
 await pool.query('update employees set user_id=null where id=$1',[a.employee]);const missing={...body,requestKey:randomUUID()};const failed=await send(missing);proof.missing=failed.body.delivery?.status==='Failed'&&failed.body.delivery.failureMessage.includes('staff login')&&(await count())===1;
 await pool.query('update employees set user_id=$1 where id=$2',[b.staff,a.employee]);proof.foreignLogin=(await send(missing)).body.delivery?.status==='Failed'&&(await count())===1;
 await pool.query('update employees set user_id=$1 where id=$2',[a.staff,a.employee]);proof.repaired=(await send(missing)).body.delivery?.status==='Delivered'&&(await count())===2;
 await pool.query("create function zz_presence_failure() returns trigger language plpgsql as 'begin raise exception ''ZZ TEST controlled inbox failure''; end'; create trigger zz_presence_failure before insert on notifications for each row execute function zz_presence_failure()");
 const interrupted={...body,requestKey:randomUUID()};const failure=await send(interrupted);proof.failure=failure.body.delivery?.status==='Failed'&&(await count())===2;
 await pool.query('drop trigger zz_presence_failure on notifications; drop function zz_presence_failure()');proof.retry=(await send(interrupted)).body.delivery?.status==='Delivered'&&(await count())===3;
 const pending={...body,requestKey:randomUUID()};const hash=createHash('sha256').update(JSON.stringify([pending.employeeId,pending.shiftRowId,pending.shiftDate,pending.reason,a.branch])).digest('hex');
 await pool.query('insert into presence_notification_deliveries(tenant_id,request_key,request_hash,employee_id,branch_id,shift_row_id,shift_date,created_by) values($1,$2,$3,$4,$5,$6,$7,$8)',[a.tenant,pending.requestKey,hash,a.employee,a.branch,a.shift,pending.shiftDate,a.manager]);
 const pendingRows=await readPresenceDeliveries(db,a.tenant,[a.employee],pending.shiftDate,[a.branch]);proof.pending=pendingRows[0]?.status==='Pending'&&(await readPresenceDeliveries(db,b.tenant,[a.employee],pending.shiftDate)).length===0&&(await readPresenceDeliveries(db,a.tenant,[a.employee],pending.shiftDate,[branch2])).length===0;
 proof.resume=(await send(pending)).body.delivery?.status==='Delivered'&&(await count())===4;
 console.log('PRESENCE_PROOF='+JSON.stringify(proof));
} catch(error) {console.log('PRESENCE_SETUP='+JSON.stringify({name:error?.name,code:error?.code,column:error?.column,table:error?.table}));process.exitCode=1;}
finally{if(server)await new Promise(resolve=>server.close(resolve));await pool.end();}
`);
      const run = spawnSync(process.execPath, [join(APP, 'node_modules/tsx/dist/cli.mjs'), '--tsconfig', join(APP, 'tsconfig.json'), script], {
        cwd: APP, env: { ...process.env, DATABASE_URL: database.url }, encoding: 'utf8', timeout: 100_000,
      });
      const match = /PRESENCE_PROOF=(.+)/.exec(run.stdout ?? '');
      if (!match) console.info('Presence fixture metadata', /PRESENCE_SETUP=(.+)/.exec(run.stdout ?? '')?.[1] ?? 'No completed result');
      expect(run.status, 'The bounded delivery fixture finished').toBe(0);
      expect(match, 'The actual handler produced review results').not.toBeNull();
      proof = JSON.parse(match![1]);
    } finally { await database.drop(); removeFixture(directory); }
  }, 180_000);

  it('stores a staff inbox message and reports Delivered', () => expect(proof.delivery && proof.inbox).toBe(true));
  it('FINDING 1 (high, fixed): concurrent replay stores one message; prescribed fix: durable key, payload fingerprint and atomic result', () => expect(proof.replay && proof.changed).toBe(true));
  it('another park, branch, staff sender, signed-out caller and missing context create no attempts', () => expect(proof.fences && proof.noRefusedWrites).toBe(true));
  it('staff read their own inbox; another park cannot read or mark it', () => expect(proof.privateInbox && proof.readSeparate).toBe(true));
  it('FINDING 2 (high, fixed): missing and foreign logins fail clearly, then retry after connection; prescribed fix: current active park placement', () => expect(proof.missing && proof.foreignLogin && proof.repaired).toBe(true));
  it('FINDING 3 (medium, fixed): controlled inbox failure stores Failed and retries once; prescribed fix: transaction and durable result', () => expect(proof.failure && proof.retry).toBe(true));
  it('a stored Pending attempt is visible only in scope and resumes after interruption', () => expect(proof.pending && proof.resume).toBe(true));
  it('live rows show delivery while the staff Bell retains the full message without manager navigation', () => {
    const live = readFileSync(join(APP, 'client/src/pages/timekeeping-live-page.tsx'), 'utf8');
    const bell = readFileSync(join(APP, 'client/src/components/notification-bell.tsx'), 'utf8');
    expect(live).toContain('sessionStorage.getItem(`presence-ping:${key}`)');
    expect(live).toContain('Inbox: {delivery.status}');
    expect(live).toContain('read status is separate');
    expect(bell).toContain('if (notification.type === "timekeeping_ping") return;');
    expect(bell).toContain('"whitespace-pre-wrap"');
    const pending: LocalPresenceDelivery = { requestKey: 'new-request', status: 'Pending', failureMessage: null, unconfirmed: true };
    const previous = { requestKey: 'old-request', status: 'Delivered' as const, failureMessage: null, updatedAt: '2099-10-13T12:00:00.000Z' };
    expect(selectPresenceDelivery(previous, pending), 'An older server result cannot hide the unconfirmed key').toBe(pending);
    const confirmed = { ...previous, requestKey: pending.requestKey };
    expect(selectPresenceDelivery(confirmed, pending), 'The same delivered request can reconcile a lost response').toBe(confirmed);
    expect(selectPresenceDelivery(previous, { ...pending, unconfirmed: undefined, status: 'Failed', updatedAt: '2099-10-13T11:00:00.000Z' })).toBe(previous);
  });
});
