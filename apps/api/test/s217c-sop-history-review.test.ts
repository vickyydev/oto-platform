import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, stopTestServer } from '@oto/db/testing';

/** SCRUM-519: real SOP routes, real PostgreSQL and the deployed migrator.
 * Passing pins cover another park, another branch, retry and concurrent saves.
 * Saved content remains immutable; restoring it retains today's publication
 * and branch choices. A failed snapshot must roll back the replacement too.
 */
const APP = fileURLToPath(new URL('../../oto-app/', import.meta.url));
const available = existsSync(join(APP, 'node_modules/tsx/dist/cli.mjs'));
let results: Record<string, boolean>;

it('FINDING 1 high, fixed: SOP references stay in the app schema; prescribed fix: unqualified migration references', () => {
  const journal = JSON.parse(readFileSync(join(APP, 'migrations/meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
  const tag = journal.entries.find(entry => entry.tag.endsWith('_sop_revision_history'))?.tag;
  expect(tag).toBeTruthy();
  expect(readFileSync(join(APP, `migrations/${tag}.sql`), 'utf8')).not.toMatch(/"public"\./);
});

describe.skipIf(!available)('SOP history release review', () => {
  afterAll(stopTestServer);
  beforeAll(async () => {
    const database = await createTestDatabase();
    const directory = mkdtempSync(join(tmpdir(), 'oto-sop-review-'));
    const env = { ...process.env, DATABASE_URL: database.url, DB_SCHEMA: 'otoapp',
      APP_ENV: 'dev', DEPLOY_ENV: 'local', OBJECT_STORAGE: 'local',
      STORAGE_ENV_PREFIX: 'zz-sop', OTOAPP_JOBS: 'platform', NODE_ENV: 'test', OTOAPP_LEGACY_LOGIN: 'true' };
    try {
      const migration = spawnSync(process.execPath, [join(APP, 'script/migrate.mjs')],
        { cwd: APP, env, encoding: 'utf8', timeout: 120_000 });
      expect(migration.status, 'App migration completes').toBe(0);
      const script = join(directory, 'sop.mts');
      writeFileSync(script, String.raw`
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
const app=${JSON.stringify(APP)};
const moduleUrl=path=>pathToFileURL(app+path).href;
let stage='imports';
const report=error=>{console.log('SOP_SETUP_ERROR='+JSON.stringify({stage,name:error?.name,code:error?.code,column:error?.column,table:error?.table,constraint:error?.constraint}));process.exit(1);};
process.on('uncaughtException',report);process.on('unhandledRejection',report);
const require=createRequire(app+'package.json'),express=require('express'),pg=require('pg');
const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();await c.query('set search_path to otoapp');
const q=async(text,values=[])=>{stage='SQL '+text.split(/\s+/).slice(0,3).join(' ');return (await c.query(text,values)).rows;};
const {storage}=await import(moduleUrl('server/storage.ts'));
const {registerSopRoutes}=await import(moduleUrl('server/sop-routes.ts'));
const api=express(),actors=new Map();api.use(express.json());
api.use((req,_res,next)=>{const actor=actors.get(req.headers['x-zz-test-actor']);req.isAuthenticated=()=>!!actor;req.user=actor;req.userWithAccess=actor;req.logout=cb=>cb();next();});
registerSopRoutes(api,async tenantId=>tenantId);
api.use((error,_req,res,_next)=>res.status(500).json({message:'ZZ TEST request failed',code:error?.code}));
let server;
try {
 const groups=[];
 for(const label of ['A','B']){
  const tenant=randomUUID(),user=randomUUID();
  await q('insert into tenants(id,name,slug) values($1,$2,$3)',[tenant,'ZZ TEST SOP '+label,'zz-sop-'+tenant]);
  const branch=(await q("insert into branches(tenant_id,name,address) values($1,$2,'ZZ TEST address') returning id",[tenant,'ZZ TEST Branch '+label]))[0].id;
  await q("insert into users(id,email,password,full_name,role) values($1,$2,'ZZ TEST unused credential',$3,'admin')",[user,user+'@zz-test.invalid','ZZ TEST Admin '+label]);
  await q("insert into user_branch_access(tenant_id,user_id,access_scope) values($1,$2,'all_branches')",[tenant,user]);
  actors.set(user,await storage.getUserWithBranchAccess(user));groups.push({tenant,user,branch});
 }
 const [a,b]=groups;
 const branch2=(await q("insert into branches(tenant_id,name,address) values($1,'ZZ TEST Branch A2','ZZ TEST address') returning id",[a.tenant]))[0].id;
 const limited=randomUUID(),staff=randomUUID(),secondAdmin=randomUUID();
 for(const [id,role] of [[limited,'operator_admin'],[staff,'staff'],[secondAdmin,'admin']]){
  await q("insert into users(id,email,password,full_name,role) values($1,$2,'ZZ TEST unused credential','ZZ TEST SOP Actor',$3)",[id,id+'@zz-test.invalid',role]);
  const row=await storage.getUser(id);
  actors.set(id,{...row,tenantId:a.tenant,allowedBranchIds:[a.branch],hasAllBranchesAccess:id===secondAdmin});
 }
 server=await new Promise(resolve=>{const s=api.listen(0,'127.0.0.1',()=>resolve(s));});
 const origin='http://127.0.0.1:'+server.address().port;
 const call=async(method,path,actor,body)=>{stage='HTTP '+method+' '+path.split('/').slice(0,3).join('/');const response=await fetch(origin+path,{method,headers:{...(actor?{'x-zz-test-actor':actor}:{}),...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});const text=await response.text();let data;try{data=JSON.parse(text);}catch{data=null;}return {status:response.status,data};};
 const rows={};
 const created=await call('POST','/api/sops',a.user,{title:'ZZ TEST Procedure',body:'ZZ TEST first content',status:'published',scope:'BRANCHES',branchIds:[a.branch],rules:['ZZ TEST first rule']});
 if(created.status!==201)throw new Error('Creation setup');
 const id=created.data.id,path='/api/sops/'+id;
 rows.publishedRead=(await call('GET',path,staff)).status===200;
 const mutationId=randomUUID(),saveBody={title:'ZZ TEST Updated',body:'ZZ TEST second content',expectedVersion:0,mutationId};
 const edited=await call('PATCH',path,a.user,saveBody);
 const history=await call('GET',path+'/revisions',a.user);
 const revision=history.data?.items?.[0];
 if(!revision)throw new Error('History setup');
 const detail=await call('GET',path+'/revisions/'+revision.id,a.user);
 actors.set('missing-context',{...actors.get(a.user),tenantId:undefined});
 rows.missingContext=(await call('GET',path+'/revisions','missing-context')).status===403&&(await call('GET',path+'/revisions/'+revision.id,'missing-context')).status===403&&(await call('POST',path+'/revisions/'+revision.id+'/restore','missing-context',{expectedVersion:1,mutationId:randomUUID()})).status===403;
 rows.previousContent=edited.status===200&&edited.data.editVersion===1&&revision.version===0&&revision.savedById===a.user&&!!revision.savedAt&&revision.title==='ZZ TEST Procedure'&&detail.data.content.body==='ZZ TEST first content'&&!('content' in revision)&&!('result' in detail.data);
 rows.foreignPark=(await call('GET',path+'/revisions',b.user)).status===404&&(await call('GET',path+'/revisions/'+revision.id,b.user)).status===404&&(await call('POST',path+'/revisions/'+revision.id+'/restore',b.user,{expectedVersion:1,mutationId:randomUUID()})).status===404;
 rows.staffHistory=(await call('GET',path+'/revisions',staff)).status===403&&(await call('POST',path+'/revisions/'+revision.id+'/restore',staff,{expectedVersion:1,mutationId:randomUUID()})).status===403&&(await call('GET',path+'/revisions')).status===401;
 const replay=await call('PATCH',path,a.user,saveBody);
 rows.exactReplay=isDeepStrictEqual(replay,edited)&&(await q('select count(*)::int n from sop_article_revisions where article_id=$1',[id]))[0].n===1;
 rows.changedReplay=(await call('PATCH',path,a.user,{...saveBody,body:'ZZ TEST substituted'})).status===409&&(await call('PATCH',path,secondAdmin,saveBody)).status===409;
 const current=(await call('GET',path,a.user)).data;
 const concurrent=await Promise.all(['left','right'].map(suffix=>call('PATCH',path,a.user,{body:'ZZ TEST '+suffix,expectedVersion:current.editVersion,mutationId:randomUUID()})));
 rows.concurrent=concurrent.map(x=>x.status).sort().join(',')==='200,409'&&(await q('select edit_version from sop_articles where id=$1',[id]))[0].edit_version===2;
 const hidden=await call('POST','/api/sops',a.user,{title:'ZZ TEST A2 Procedure',body:'ZZ TEST A2 original',scope:'BRANCHES',branchIds:[branch2]});
 const hiddenPath='/api/sops/'+hidden.data.id;
 await call('PATCH',hiddenPath,a.user,{body:'ZZ TEST A2 next',expectedVersion:0,mutationId:randomUUID()});
 const hiddenRevision=(await call('GET',hiddenPath+'/revisions',a.user)).data.items[0];
 rows.foreignBranch=(await call('GET',hiddenPath+'/revisions',limited)).status===404&&(await call('GET',hiddenPath+'/revisions/'+hiddenRevision.id,limited)).status===404&&(await call('POST',hiddenPath+'/revisions/'+hiddenRevision.id+'/restore',limited,{expectedVersion:1,mutationId:randomUUID()})).status===404&&(await call('PATCH',hiddenPath,limited,{body:'ZZ TEST unavailable',scope:'BRANCHES',branchIds:[a.branch],expectedVersion:1,mutationId:randomUUID()})).status===404;
 rows.substitutedRevision=(await call('GET',path+'/revisions/'+hiddenRevision.id,a.user)).status===404&&(await call('POST',path+'/revisions/'+hiddenRevision.id+'/restore',a.user,{expectedVersion:2,mutationId:randomUUID()})).status===404;
 const archived=await call('PATCH',path,a.user,{status:'archived',expectedVersion:2,mutationId:randomUUID()});
 const restoreBody={expectedVersion:3,mutationId:randomUUID()};
 const restored=await call('POST',path+'/revisions/'+revision.id+'/restore',a.user,restoreBody);
 rows.restoreContent=archived.status===200&&restored.status===200&&restored.data.body==='ZZ TEST first content'&&restored.data.rules[0]==='ZZ TEST first rule'&&restored.data.status==='archived'&&restored.data.branchIds.join(',')===a.branch&&(await call('GET',path,staff)).status===404;
 rows.restoreReplay=isDeepStrictEqual(await call('POST',path+'/revisions/'+revision.id+'/restore',a.user,restoreBody),restored);
 const reopened=await call('PATCH',path,a.user,{status:'published',expectedVersion:4,mutationId:randomUUID()});
 rows.reopenPublished=reopened.status===200&&(await call('GET',path,staff)).data.body==='ZZ TEST first content'&&(await storage.getSopArticles(a.tenant,a.branch,{status:'published'})).some(article=>article.id===id&&article.body==='ZZ TEST first content');
 let immutable=false;try{await q("update sop_article_revisions set saved_by_name='ZZ TEST replacement' where id=$1",[revision.id]);}catch(error){immutable=error.code==='P0001';}
 rows.immutable=immutable&&(await call('GET',path+'/revisions/'+revision.id,a.user)).data.savedByName==='ZZ TEST Admin A';
 await q("create function zz_sop_snapshot_failure() returns trigger language plpgsql as $$ begin raise exception 'ZZ TEST injected'; end $$");
 await q('create trigger zz_sop_snapshot_failure before insert on sop_article_revisions for each row execute function zz_sop_snapshot_failure()');
 const failed=await call('PATCH',path,a.user,{body:'ZZ TEST must roll back',expectedVersion:5,mutationId:randomUUID()});
 await q('drop trigger zz_sop_snapshot_failure on sop_article_revisions');
 const afterFailure=(await call('GET',path,a.user)).data;
 rows.snapshotRollback=failed.status===500&&afterFailure.editVersion===5&&afterFailure.body==='ZZ TEST first content';
 const legacy={body:'ZZ TEST legacy content'};await call('PATCH',path,a.user,legacy);await call('PATCH',path,a.user,legacy);
 rows.legacyReplay=(await call('GET',path,a.user)).data.editVersion===6;
 const page=await call('GET',path+'/revisions?beforeVersion=3',a.user);
 rows.pagination=page.status===200&&page.data.items.map(x=>x.version).join(',')==='2,1,0'&&(await call('GET',path+'/revisions?beforeVersion=-1',a.user)).status===400;
 await call('DELETE',path,a.user);
 rows.deletedUnavailable=(await call('GET',path+'/revisions',a.user)).status===404&&(await call('POST',path+'/revisions/'+revision.id+'/restore',a.user,{expectedVersion:6,mutationId:randomUUID()})).status===404&&(await q('select count(*)::int n from sop_article_revisions where article_id=$1',[id]))[0].n===0;
 console.log('SOP_RESULTS='+JSON.stringify(rows));
} finally {if(server)await new Promise(resolve=>server.close(resolve));await c.end();const {pool}=await import(moduleUrl('server/db.ts'));await pool.end();}
process.exit(0);
`);
      const run = spawnSync(process.execPath, [join(APP, 'node_modules/tsx/dist/cli.mjs'), '--tsconfig', join(APP, 'tsconfig.json'), script],
        { cwd: APP, env, encoding: 'utf8', timeout: 240_000 });
      const match = /SOP_RESULTS=(.+)/.exec(run.stdout ?? '');
      if (run.status !== 0) {
        const output = (run.stdout ?? '') + (run.stderr ?? '');
        console.info('SOP review setup', /SOP_SETUP_ERROR=(.+)/.exec(output)?.[1] ?? 'No result marker');
        console.info('SOP review frames', [...output.matchAll(/[A-Za-z0-9_-]+\.(?:ts|mts|js|mjs):\d+:\d+/g)].map(x => x[0]));
      }
      expect(run.status, 'SOP child completes').toBe(0);
      expect(match, 'SOP result recorded').toBeTruthy();
      results = JSON.parse(match![1]!);
    } finally {
      await database.drop();
      const absolute = resolve(directory), bound = relative(resolve(tmpdir()), absolute);
      expect(!isAbsolute(bound) && !bound.startsWith('..') && bound.startsWith('oto-sop-review-')).toBe(true);
      rmSync(absolute, { recursive: true, force: true });
    }
  }, 420_000);

  it('stores previous content, author and time without returning full content in the list', () => expect(results.previousContent).toBe(true));
  it('published staff reading continues and history uses the current editing permission', () => expect(results.publishedRead && results.staffHistory).toBe(true));
  it('another park cannot list, read or restore these revisions', () => expect(results.foreignPark).toBe(true));
  it('FINDING 2 high, fixed: history needs resolved park context; prescribed fix: require loaded actor tenant before history queries', () => expect(results.missingContext).toBe(true));
  it('another branch cannot read, restore or move an inaccessible article', () => expect(results.foreignBranch).toBe(true));
  it('a substituted article revision cannot be read or restored', () => expect(results.substitutedRevision).toBe(true));
  it('an exact save retry returns its first result without another revision', () => expect(results.exactReplay).toBe(true));
  it('changed payloads and another author cannot reuse a save identifier', () => expect(results.changedReplay).toBe(true));
  it('concurrent editors produce one replacement and one reload response', () => expect(results.concurrent).toBe(true));
  it('restore keeps current publication and branch choices and safely replays', () => expect(results.restoreContent && results.restoreReplay).toBe(true));
  it('reopening restores published staff and knowledge-reader visibility', () => expect(results.reopenPublished).toBe(true));
  it('previous revisions are immutable and a failed snapshot rolls back the replacement', () => expect(results.immutable && results.snapshotRollback).toBe(true));
  it('legacy same-content saves do not add duplicate revisions', () => expect(results.legacyReplay).toBe(true));
  it('history is ordered with a validated version cursor', () => expect(results.pagination).toBe(true));
  it('deletion keeps its existing meaning and provides no recovery door', () => expect(results.deletedUnavailable).toBe(true));
});
