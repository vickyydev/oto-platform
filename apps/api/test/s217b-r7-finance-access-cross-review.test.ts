import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase } from '@oto/db/testing';

/**
 * SCRUM-191 round 7, independent finance organisation and OAuth review.
 * Default/explicit/null mappings, actor/session/park binding, callback replay,
 * two park groups claiming one organisation, reports and disconnects are
 * driven with actual routers and an in-memory SDK stand-in.
 * FINDING 1 (medium): a late failed refresh cannot deactivate a connection
 * another refresh already renewed. Prescribed fix: serialize/reread per token
 * or condition failure deactivation on the unchanged credential version.
 */
const APP = fileURLToPath(new URL('../../oto-app/', import.meta.url));
const available = existsSync(join(APP, 'node_modules/tsx/dist/cli.mjs'));
type Results = {
  mappings: boolean;
  identity: boolean;
  replay: boolean;
  claimRace: boolean;
  reports: boolean;
  disconnect: boolean;
  refreshSetup: boolean;
  refreshActive: boolean;
};
let results: Results;

async function run(args: string[], environment: NodeJS.ProcessEnv, timeoutMs: number) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, args, { cwd: APP, env: environment, stdio: 'pipe' });
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
        reject(new Error('ZZ TEST finance access child did not finish'));
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

describe.skipIf(!available)('round 7 independent finance and OAuth lifecycle review', () => {
  beforeAll(async () => {
    const database = await createTestDatabase();
    const directory = mkdtempSync(join(tmpdir(), 'oto-finance-access-cross-'));
    try {
      const env = {
        ...process.env,
        DATABASE_URL: database.url,
        APP_ENV: 'dev',
        DEPLOY_ENV: 'local',
        DB_SCHEMA: 'otoapp',
        OBJECT_STORAGE: 'local',
        STORAGE_ENV_PREFIX: 'zz-test',
        XERO_REDIRECT_URI: 'http://127.0.0.1/zz-test-xero/callback',
      };
      const migrated = await run([join(APP, 'script/migrate.mjs')], env, 180_000);
      expect(migrated.status, migrated.stderr).toBe(0);
      const script = join(directory, 'finance-access-review.mts');
      writeFileSync(
        script,
        `
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(${JSON.stringify(join(APP, 'package.json'))});
const express=require('express'),session=require('express-session'),pg=require('pg');
const {pool}=await import(${JSON.stringify(pathToFileURL(join(APP, 'server/db.ts')).href)});
const {createXeroRouter}=await import(${JSON.stringify(pathToFileURL(join(APP, 'server/xero-routes.ts')).href)});
const {default:financeRouter}=await import(${JSON.stringify(pathToFileURL(join(APP, 'server/finance-sync-routes.ts')).href)});
const {resolveFinanceOrganisation}=await import(${JSON.stringify(pathToFileURL(join(APP, 'server/lib/financeOrganisationAccess.ts')).href)});
const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();await c.query('set search_path to otoapp');
const parks=Array.from({length:4},()=>randomUUID()),actors=Array.from({length:5},()=>randomUUID());
const orgs=Array.from({length:7},(_,i)=>'ZZ TEST Cross Finance '+i+' '+randomUUID());
let target=orgs[4],exchanges=0,reportCalls=0,refreshCalls=0,refreshMode=false,releaseFailure;
const lateFailure=new Promise(resolve=>{releaseFailure=resolve;});
const credentials=()=>({access_token:randomBytes(24).toString('hex'),refresh_token:randomBytes(24).toString('hex'),expires_in:3600});
const fake=state=>({
 buildConsentUrl:async()=> 'https://zz-test.invalid/consent?state='+state,
 apiCallback:async()=>{exchanges++;return credentials();},updateTenants:async()=>{},
 tenants:[{tenantId:target,tenantName:'ZZ TEST Cross Finance'}],setTokenSet:()=>{},
 refreshWithRefreshToken:async()=>{refreshCalls++;const call=refreshCalls;if(!refreshMode)return credentials();if(call===1){while(refreshCalls<2)await new Promise(r=>setTimeout(r,10));return credentials();}await lateFailure;throw new Error('ZZ TEST late provider refresh failure');},
 accountingApi:Object.fromEntries(['getReportProfitAndLoss','getReportBalanceSheet','getInvoices','getAccounts','getReportBankSummary','getOrganisations'].map(name=>[name,async org=>{reportCalls++;return {body:{organisation:org}};}]))
});
const app=express();app.use(express.json());app.use(session({secret:randomBytes(32).toString('hex'),resave:false,saveUninitialized:false}));
app.use((req,res,next)=>{const park=req.header('x-zz-park'),actor=req.header('x-zz-actor');Object.assign(req,{user:park?{id:actor,role:'admin'}:undefined,userWithAccess:park?{id:actor,role:'admin',tenantId:park==='unplaced'?undefined:park}:undefined,isAuthenticated:()=>!!park});next();});
app.use('/xero',createXeroRouter(fake));app.use('/finance',financeRouter);
const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const origin='http://127.0.0.1:'+server.address().port;
const contexts=parks.map((park,i)=>({park,actor:actors[i],cookie:''}));const [a,b,firstClaim,secondClaim]=contexts;
async function request(ctx,path,method='GET',body){const response=await fetch(origin+path,{method,redirect:'manual',headers:{...(ctx.park?{'x-zz-park':ctx.park,'x-zz-actor':ctx.actor}:{}),...(ctx.cookie?{cookie:ctx.cookie}:{}),...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});const cookie=response.headers.get('set-cookie');if(cookie)ctx.cookie=cookie.split(';')[0];return {status:response.status,location:response.headers.get('location'),body:response.headers.get('content-type')?.includes('application/json')?await response.json():null};}
async function begin(ctx){const response=await request(ctx,'/xero/connect');assert.equal(response.status,302);const state=new URL(response.location).searchParams.get('state');assert.ok(/^[a-f0-9]{64}$/.test(state));return state;}
const callback=state=>'/xero/callback?state='+state+'&code='+randomBytes(24).toString('hex');
async function active(park){return Number((await c.query('select count(*) as n from xero_tokens where tenant_id=$1 and is_active',[park])).rows[0].n);}
const result={};
try {
 for(let i=0;i<parks.length;i++){await c.query('insert into tenants(id,name,slug) values($1,$2,$3)',[parks[i],'ZZ TEST Cross Finance Park '+i,'zz-cross-finance-'+parks[i]]);}
 for(let i=0;i<actors.length;i++)await c.query('insert into users(id,email,password,full_name) values($1,$2,$3,$4)',[actors[i],'zz-cross-finance-'+actors[i]+'@example.invalid',randomBytes(24).toString('hex'),'ZZ TEST Cross Finance Actor '+i]);
 for(const [park,org] of [[parks[0],orgs[0]],[parks[1],orgs[1]],[parks[2],orgs[2]],[parks[3],orgs[3]],[parks[0],orgs[5]],[parks[1],orgs[5]],[parks[0],orgs[6]],[null,orgs[6]]])await c.query("insert into xero_tokens(tenant_id,xero_tenant_id,xero_tenant_name,access_token,refresh_token,expires_at,updated_at) values($1,$2,'ZZ TEST Organisation',$3,$4,now()+interval '1 hour',now()+case when $2=$5 then interval '1 hour' else interval '0 hours' end)",[park,org,randomBytes(24).toString('hex'),randomBytes(24).toString('hex'),orgs[1]]);
 // Ambiguous mappings are historical only, leaving A's own connection as its default.
 await c.query('update xero_tokens set is_active=false where xero_tenant_id=any($1)',[[orgs[5],orgs[6]]]);
 for(const org of [orgs[0],orgs[1]])await c.query("insert into xero_sync_runs(tenant_id,sync_type,status) values($1,'ZZ TEST CROSS','OK')",[org]);
 const defaultHistory=await request(a,'/finance/sync-history');assert.equal(defaultHistory.status,200);assert.equal(defaultHistory.body[0].tenantId,orgs[0]);
 assert.equal((await request(a,'/finance/sync-history?tenantId='+encodeURIComponent(orgs[0]))).status,200);
 for(const org of [orgs[1],orgs[5],orgs[6],'ZZ TEST missing'])assert.equal((await request(a,'/finance/sync-history?tenantId='+encodeURIComponent(org))).status,404);
 assert.equal((await request({...a,park:'unplaced'},'/finance/sync-history')).status,403);
 assert.equal((await request({},'/finance/sync-history')).status,401);
 assert.equal(await resolveFinanceOrganisation({userWithAccess:{tenantId:parks[0]},body:{tenantId:null},query:{}}),orgs[0]);
 assert.equal((await request(a,'/finance/sync-history?tenantId=one&tenantId=two')).status,400);result.mappings=true;
 for(const path of ['profit-and-loss','balance-sheet','invoices','accounts','bank-summary','organisation']){const response=await request(a,'/xero/'+path);assert.equal(response.status,200);assert.equal(response.body.organisation,orgs[0]);}
 assert.equal(reportCalls,6);result.reports=true;
 const state=await begin(a);const before=exchanges;
 for(const context of [{...a,actor:actors[4]},{...a,park:parks[1],actor:actors[1]},{...a,cookie:''}]){const response=await request(context,callback(state));assert.ok(response.location.includes('xero=error'));assert.equal(exchanges,before);}
 const success=await request(a,callback(state));assert.ok(success.location.includes('xero=connected'));assert.equal(exchanges,before+1);result.identity=true;
 assert.ok((await request(a,callback(state))).location.includes('xero=error'));assert.equal(exchanges,before+1);result.replay=true;
 target='ZZ TEST Concurrent Claim '+randomUUID();orgs.push(target);
 const firstState=await begin(firstClaim),secondState=await begin(secondClaim);
 const claimed=await Promise.all([request(firstClaim,callback(firstState)),request(secondClaim,callback(secondState))]);
 assert.equal(claimed.filter(row=>row.location.includes('xero=connected')).length,1);assert.equal(claimed.filter(row=>row.location.includes('xero=error')).length,1);
 const mappings=(await c.query('select tenant_id from xero_tokens where xero_tenant_id=$1',[target])).rows;assert.equal(mappings.length,1);
 const loser=mappings[0].tenant_id===firstClaim.park?secondClaim:firstClaim;const old=loser===firstClaim?orgs[2]:orgs[3];assert.equal(Number((await c.query('select count(*) as n from xero_tokens where tenant_id=$1 and xero_tenant_id=$2 and is_active',[loser.park,old])).rows[0].n),1);result.claimRace=true;
 const beforeA=await active(a.park);assert.equal((await request(b,'/xero/disconnect','POST')).status,200);assert.equal(await active(a.park),beforeA);assert.equal(await active(b.park),0);assert.equal((await request(b,'/xero/status')).body.connected,false);result.disconnect=true;
 // Force only A's current generated token to expire; two refresh calls overlap.
 await c.query("update xero_tokens set expires_at=now()-interval '1 minute' where tenant_id=$1 and is_active",[a.park]);refreshMode=true;
 const first=request(a,'/xero/accounts'),second=request(a,'/xero/accounts');
 const renewed=await Promise.race([first,second]);assert.equal(renewed.status,200);releaseFailure();
 const statuses=(await Promise.all([first,second])).map(row=>row.status).sort();assert.deepEqual(statuses,[200,500]);
 const token=(await c.query('select is_active,expires_at from xero_tokens where tenant_id=$1 order by updated_at desc limit 1',[a.park])).rows[0];
 assert.ok(new Date(token.expires_at)>new Date());result.refreshSetup=true;result.refreshActive=token.is_active;
 console.log('FINANCE_ACCESS_CROSS_RESULTS='+JSON.stringify(result));
} finally {releaseFailure();await new Promise(resolve=>server.close(resolve));await c.end();await pool.end();}
`,
      );
      const response = await run(
        [
          join(APP, 'node_modules/tsx/dist/cli.mjs'),
          '--tsconfig',
          join(APP, 'tsconfig.json'),
          script,
        ],
        env,
        180_000,
      );
      expect(response.status, response.stderr).toBe(0);
      const payload = /FINANCE_ACCESS_CROSS_RESULTS=(.+)/.exec(response.stdout);
      expect(payload, response.stdout).toBeTruthy();
      results = JSON.parse(payload![1]);
    } finally {
      await database.drop();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 400_000);

  for (const key of [
    'mappings',
    'identity',
    'replay',
    'claimRace',
    'reports',
    'disconnect',
    'refreshSetup',
  ] as const) {
    it(key + ': its intended controls and refusals hold', () => {
      expect(results[key]).toBe(true);
    });
  }
  it.fails(
    'FINDING 1 (medium): a late failed refresh leaves the renewed connection active; prescribed fix: serialize/reread the token or condition deactivation on its unchanged credential version',
    () => {
      expect(results.refreshActive).toBe(true);
    },
  );
});
