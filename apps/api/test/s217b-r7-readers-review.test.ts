import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase } from '@oto/db/testing';

/**
 * SCRUM-516, the form editor and permission home-branch readers.
 * FINDING 1 (medium): the editor's translation-array door needs its owned
 * form/version context. Prescribed fix: checked draft/published selection.
 * FINDING 2 (medium): a historical foreign employee link cannot choose a
 * module's home branch. Prescribed fix: request park and owned employees.
 * The client must send its displayed version on save and refresh that
 * version's translations; its real staged editor recheck is recorded in QA.
 */
const APP = fileURLToPath(new URL('../../oto-app/', import.meta.url));
const available = existsSync(join(APP, 'node_modules/tsx/dist/cli.mjs'));
let result: {
  ownVersionWrite: boolean;
  foreignVersionWrite: boolean;
  ownArray: boolean;
  foreignArray: boolean;
  versionSelection: boolean;
  ownHomeControl: boolean;
  historicalHome: boolean;
  missingContext: boolean;
};

describe.skipIf(!available)('round 7 form and home-branch reader review', () => {
  beforeAll(async () => {
    const database = await createTestDatabase({ otoapp: true });
    const directory = mkdtempSync(join(tmpdir(), 'oto-reader-review-'));
    try {
      const script = join(directory, 'readers.mts');
      writeFileSync(script, String.raw`
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:http';
const app=${JSON.stringify(APP)};
const moduleUrl=path=>pathToFileURL(app+path).href;
let stage='imports';
const report=error=>{process.stdout.write('READER_SETUP_ERROR='+JSON.stringify({stage,name:error?.name,code:error?.code,column:error?.column,table:error?.table,constraint:error?.constraint})+'\n');process.exit(1);};
process.on('uncaughtException',report);process.on('unhandledRejection',report);
const require=createRequire(app+'package.json');
const express=require('express');const pg=require('pg');
const c=new pg.Client({connectionString:process.env.DATABASE_URL});
await c.connect();await c.query('set search_path to otoapp');
const q=async(text,values=[]) => {stage='SQL '+text.split(/\s+/).slice(0,3).join(' ');return (await c.query(text,values)).rows;};
const {storage}=await import(moduleUrl('server/storage.ts'));
const {requireModule}=await import(moduleUrl('server/auth-middleware.ts'));
const {registerRoutes}=await import(moduleUrl('server/routes.ts'));
const api=express();api.use(express.json());const actors=new Map();
api.use((req,_res,next)=>{const id=req.headers['x-zz-test-actor'];const actor=actors.get(id);req.isAuthenticated=()=>!!actor;req.user=actor?.user;req.userWithAccess=actor?.access;next();});
api.get('/zz-permission/:branchId',requireModule('today'),(_req,res)=>res.json({allowed:true}));
const httpServer=createServer(api);await registerRoutes(httpServer,api);
const groups=[];let server;
try {
 for(const label of ['A','B']){
  const tenant=randomUUID(),user=randomUUID();
  await q('insert into tenants(id,name,slug) values($1,$2,$3)',[tenant,'ZZ TEST Reader '+label,'zz-reader-'+tenant]);
  const branch=(await q("insert into branches(tenant_id,name,address) values($1,$2,'ZZ TEST Address') returning id",[tenant,'ZZ TEST Reader Branch '+label]))[0].id;
  await q("insert into users(id,email,password,full_name,role) values($1,$2,'ZZ TEST unused credential',$3,'admin')",[user,user+'@zz-test.invalid','ZZ TEST Reader Admin '+label]);
  await q("insert into user_branch_access(tenant_id,user_id,access_scope) values($1,$2,'all_branches')",[tenant,user]);
  const form=(await q("insert into dropoff_forms(tenant_id,name) values($1,'ZZ TEST Reader Form') returning id",[tenant]))[0].id;
  const schema={titleKey:'dropoff.title',sections:[]};
  const published=(await q("insert into dropoff_form_versions(form_id,version_number,schema_json,is_draft) values($1,1,$2,false) returning id",[form,JSON.stringify(schema)]))[0].id;
  const draft=(await q("insert into dropoff_form_versions(form_id,version_number,schema_json,is_draft) values($1,2,$2,true) returning id",[form,JSON.stringify(schema)]))[0].id;
  await q('update dropoff_forms set active_published_version_id=$1 where id=$2',[published,form]);
  for(const [version,value] of [[published,'ZZ TEST published '+label],[draft,'ZZ TEST draft '+label]])await q("insert into i18n_translations(namespace,version_id,lang,key,value) values('dropoff',$1,'en','dropoff.title',$2)",[version,value]);
  const userAccess=await storage.getUserWithBranchAccess(user);assert.ok(userAccess);
  actors.set(user,{user:userAccess,access:userAccess});groups.push({tenant,user,branch,form,published,draft});
 }
 const [a,b]=groups;
 server=await new Promise(resolve=>{httpServer.listen(0,'127.0.0.1',()=>resolve(httpServer));});
 const origin='http://127.0.0.1:'+server.address().port;
 const call=async(method,path,actor,body)=>{stage='HTTP '+method;const response=await fetch(origin+path,{method,headers:{...(actor?{'x-zz-test-actor':actor}:{}),...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});const text=await response.text();let data;try{data=JSON.parse(text);}catch{data=null;}return {status:response.status,data};};
 const rows={};
 const save=await call('PUT','/api/dropoff-form/translation',a.user,{versionId:a.draft,lang:'en',key:'dropoff.title',value:'ZZ TEST revised A'});
 const saved=await call('GET','/api/dropoff-form/version/'+a.draft,a.user);
 rows.ownVersionWrite=save.status===200&&saved.data.translations.some(x=>x.key==='dropoff.title'&&x.value==='ZZ TEST revised A');
 const denied=await call('PUT','/api/dropoff-form/translation',b.user,{versionId:a.draft,lang:'en',key:'dropoff.title',value:'ZZ TEST foreign replay'});
 rows.foreignVersionWrite=denied.status===404&&(await q('select value from i18n_translations where version_id=$1',[a.draft]))[0].value==='ZZ TEST revised A';
 const own=await call('GET','/api/dropoff-form/'+a.form+'/translations/en',a.user);
 rows.ownArray=own.status===200&&Array.isArray(own.data)&&own.data.some(x=>x.value==='ZZ TEST revised A');
 const foreign=await call('GET','/api/dropoff-form/'+a.form+'/translations/en',b.user);
 const anonymous=await call('GET','/api/dropoff-form/'+a.form+'/translations/en');
 rows.foreignArray=foreign.status===404&&anonymous.status===401;
 await q('update dropoff_form_versions set is_draft=false where id=$1',[a.draft]);
 const fallback=await call('GET','/api/dropoff-form/'+a.form+'/translations/en',a.user);
 await q('update dropoff_forms set active_published_version_id=$1 where id=$2',[b.published,a.form]);
 const mixed=await call('GET','/api/dropoff-form/'+a.form+'/translations/en',a.user);
 rows.versionSelection=fallback.status===200&&Array.isArray(fallback.data)&&fallback.data.some(x=>x.value==='ZZ TEST published A')&&mixed.status===404;
 await q('update dropoff_forms set active_published_version_id=$1 where id=$2',[a.published,a.form]);
 await q("update users set role='staff' where id=$1",[a.user]);
 const access=await storage.getUserWithBranchAccess(a.user);actors.set(a.user,{user:access,access});
 await q("insert into employees(tenant_id,branch_id,user_id,full_name,nickname,email,created_at) values($1,$2,$3,'ZZ TEST Owned Home','ZZ TEST Home',$4,'2020-01-01')",[a.tenant,a.branch,a.user,randomUUID()+'@zz-test.invalid']);
 const control=await call('GET','/api/permissions/me',a.user);rows.ownHomeControl=control.status===200&&control.data.homeBranchId===a.branch;
 await q("insert into employees(tenant_id,branch_id,user_id,full_name,nickname,email,created_at) values($1,$2,$3,'ZZ TEST Historical Foreign Link','ZZ TEST Foreign',$4,'2030-01-01')",[b.tenant,b.branch,a.user,randomUUID()+'@zz-test.invalid']);
 const home=await call('GET','/api/permissions/me',a.user);
 rows.historicalHome=home.status===200&&home.data.homeBranchId===a.branch;
 actors.set('missing-context',{user:{...access,tenantId:a.tenant},access:undefined});
 rows.missingContext=(await call('GET','/zz-permission/'+a.branch,'missing-context')).status===403;
 console.log('READER_RESULTS='+JSON.stringify(rows));
} finally {if(server)await new Promise(resolve=>server.close(resolve));await c.end();const {pool}=await import(moduleUrl('server/db.ts'));await pool.end();}
process.exit(0);
`);
      const run = spawnSync(process.execPath, [join(APP, 'node_modules/tsx/dist/cli.mjs'), '--tsconfig', join(APP, 'tsconfig.json'), script], {
        cwd: APP,
        env: { ...process.env, DATABASE_URL: database.url, DB_SCHEMA: 'otoapp', APP_ENV: 'dev', DEPLOY_ENV: 'local', OBJECT_STORAGE: 'local', STORAGE_ENV_PREFIX: 'zz-readers', OTOAPP_JOBS: 'platform', NODE_ENV: 'test', OTOAPP_LEGACY_LOGIN: 'true' },
        encoding: 'utf8', timeout: 300_000,
      });
      const match = /READER_RESULTS=(.+)/.exec(run.stdout ?? '');
      if (run.status !== 0) {
        const output = (run.stdout ?? '') + (run.stderr ?? '');
        const marked = /READER_SETUP_ERROR=(.+)/.exec(output);
        if (marked) console.info('ZZ TEST reader setup result', marked[1]);
        const classes = [...output.matchAll(/\b(?:AssertionError|TypeError|SyntaxError|ReferenceError|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|ECONNREFUSED|ETIMEDOUT)\b/g)].map(x => x[0]);
        const frames = [...output.matchAll(/[A-Za-z0-9_-]+\.(?:ts|mts|js|mjs):\d+:\d+/g)].map(x => x[0]);
        const names = ['APP_ENV', 'STORAGE_ENV_PREFIX', 'OBJECT_STORAGE', 'DATABASE_URL', 'SESSION_SECRET', 'SESSION_PEPPER', 'KIOSK_CODE_PEPPER', 'OTP_HASH_PEPPER', 'ENCRYPTION_KEY', 'DB_SCHEMA'].filter(name => output.includes(name));
        const messages = output.split(/\r?\n/).filter(line => /(?:required|missing|BOOT|Failed|not found)/i.test(line)).map(line => line.replace(/(?:postgres(?:ql)?|https?):\/\/\S+/g, '[private URL]').replace(/["'][^"']*["']/g, '[redacted]'));
        console.info('ZZ TEST reader setup diagnostics', JSON.stringify({ classes, frames, names, messages }));
      }
      expect(run.status, 'ZZ TEST reader child did not complete').toBe(0);
      expect(match, 'ZZ TEST reader result missing').toBeTruthy();
      result = JSON.parse(match![1]!);
    } finally {
      await database.drop();
      const absolute = resolve(directory);
      const bound = relative(resolve(tmpdir()), absolute);
      expect(!isAbsolute(bound) && !bound.startsWith('..') && bound.startsWith('oto-reader-review-'), 'ZZ TEST reader cleanup stays in temporary directory').toBe(true);
      rmSync(absolute, { recursive: true, force: true });
    }
  }, 500_000);
  it('owned version save persists and the foreign replay leaves it intact', () => {
    expect(result.ownVersionWrite && result.foreignVersionWrite).toBe(true);
  });
  it('an owned employee supplies a working module home branch', () => expect(result.ownHomeControl).toBe(true));
  it('FINDING 1 medium, fixed: the editor reads its owned draft translation array; prescribed fix: checked form/version reader', () => expect(result.ownArray && result.foreignArray && result.versionSelection).toBe(true));
  it('FINDING 2 medium, fixed: historical foreign links and missing context never choose the module home branch; prescribed fix: request park and owned employees', () => expect(result.historicalHome && result.missingContext).toBe(true));
});
