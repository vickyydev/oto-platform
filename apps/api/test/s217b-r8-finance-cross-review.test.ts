import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * S2-17b round 8 (SCRUM-191), independent input-boundary review.
 * The real rehearsal module runs with VM imports supplying an in-memory pg
 * client and command runner. No SQL, psql payload or shell command executes.
 * Only test-created temporary directories are removed; app files are read.
 *
 * FINDING 1 (medium): count 184 alone permits a substituted source table.
 * Prescribed fix: compare the source table-name inventory with the baseline
 * before seeding or recording migration 0000 as applied.
 * FINDING 2 (high): psql --file accepts connection/include/shell commands.
 * Prescribed fix: refuse escaping metacommands before handing input to psql,
 * or use fixed-client SQL loading that cannot execute psql commands.
 */
const APP = fileURLToPath(new URL('../../oto-app/', import.meta.url));

type Proof = {
  sourceCount: number;
  baselineCount: number;
  hasQuizTable: boolean;
  substituted: boolean;
  acceptedInventory: boolean;
  acceptedUnsafe: boolean;
  created: number;
  dropped: number;
  existingTargetTouched: boolean;
  unsafeMarkers: boolean;
};

function probe(mode: 'inventory' | 'unsafe'): Proof {
  const moduleUrl = new URL('../../oto-app/script/restore-rehearsal.mjs', import.meta.url).href;
  const libraryUrl = new URL('../../oto-app/script/restore-rehearsal-lib.mjs', import.meta.url).href;
  const script = `
import vm from 'node:vm';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import * as url from 'node:url';
const library=await import(${JSON.stringify(libraryUrl)});
const moduleUrl=${JSON.stringify(moduleUrl)};
const mode=${JSON.stringify(mode)};
const app=${JSON.stringify(APP)};
const baseline=fs.readFileSync(path.join(app,'migrations/0000_otoapp_baseline.sql'),'utf8');
const names=[...baseline.matchAll(/^CREATE TABLE "([^"]+)"/gm)].map(m=>m[1]);
const inventory=mode==='inventory'?names.filter(n=>n!=='quiz_attempts').concat('zz_test_inventory_substitute'):names;
const proof={sourceCount:inventory.length,baselineCount:names.length,hasQuizTable:names.includes('quiz_attempts'),
 substituted:mode==='inventory'&&!inventory.includes('quiz_attempts')&&inventory.includes('zz_test_inventory_substitute'),
 acceptedInventory:false,acceptedUnsafe:false,created:0,dropped:0,existingTargetTouched:false,unsafeMarkers:false};
const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'oto-r8-cross-fixture-'));
const source=path.join(fixture,'structure.sql');
// These are marker names, not existing destinations, and the runner never executes them.
const slash=String.fromCharCode(92);
fs.writeFileSync(source,[slash+'connect ZZ_TEST_NEVER_CONNECT',slash+'include ZZ_TEST_NEVER_READ',slash+'! ZZ_TEST_NEVER_EXECUTE'].join(String.fromCharCode(10)));
proof.unsafeMarkers=fs.readFileSync(source,'utf8').split(String.fromCharCode(10)).every(line=>line.startsWith(slash));
class FakeClient {
 async connect() {} async end() {}
 async query(sql) {
  if (/^CREATE DATABASE /.test(sql)) {if(!/^CREATE DATABASE "oto_rehearsal_[a-f0-9_]+"$/.test(sql))proof.existingTargetTouched=true;proof.created++;return{rows:[]};}
  if (/^DROP DATABASE /.test(sql)) {if(!/^DROP DATABASE "oto_rehearsal_[a-f0-9_]+" WITH \\(FORCE\\)$/.test(sql))proof.existingTargetTouched=true;proof.dropped++;return{rows:[]};}
  if (sql.includes('SELECT tablename FROM pg_tables')) return {rows:inventory.slice().sort().map(tablename=>({tablename}))};
  if (sql.includes('SELECT count(*)::text AS n FROM')) return {rows:[{n:'0'}]};
  // Fixed-client input cannot execute psql commands. Refuse a marker as SQL syntax.
  if (sql.includes('ZZ_TEST_NEVER_')) throw new Error('ZZ TEST SQL-only client refused command markers');
  throw new Error('ZZ TEST probe stopped before any later database stage');
 }
}
const runner=(_executable,_args,_env,label)=>{
 if (label.endsWith('availability')) return 'ZZ TEST version';
 if (label==='source structure') {
  if(mode==='unsafe'){const fileArg=_args.indexOf('--file');const input=fileArg>=0?fs.readFileSync(_args[fileArg+1],'utf8'):'';proof.acceptedUnsafe=input.includes(slash+'connect')&&input.includes(slash+'include')&&input.includes(slash+'!');throw new Error('ZZ TEST unsafe input reached the stand-in psql boundary');}
  return '';
 }
 if(label==='sample seed'){proof.acceptedInventory=true;throw new Error('ZZ TEST substituted inventory reached the seed boundary');}
 throw new Error('ZZ TEST probe stopped before a later child stage');
};
const safeFs={...fs,rmSync:(target,options)=>{
 const absolute=path.resolve(target);const relative=path.relative(path.resolve(os.tmpdir()),absolute);
 if(!relative||relative.startsWith('..')||relative.includes(':')||!/^oto-app-rehearsal-/.test(relative))throw new Error('ZZ TEST cleanup was outside its own temporary directory');
 fs.rmSync(absolute,options);
}};
const context=vm.createContext({process,console,URL,Buffer});
const namespaces={
 'node:crypto':crypto,'node:fs':safeFs,'node:os':os,'node:path':path,'node:url':url,
 'pg':{default:{Client:FakeClient}},
 'drizzle-orm/node-postgres':{drizzle:()=>({})},
 'drizzle-orm/node-postgres/migrator':{migrate:async()=>undefined},
 './restore-rehearsal-lib.mjs':{...library,runCommand:runner},
};
const actual=new vm.SourceTextModule(fs.readFileSync(url.fileURLToPath(moduleUrl),'utf8'),{
 context,identifier:moduleUrl,initializeImportMeta(meta){meta.url=moduleUrl;}
});
await actual.link(specifier=>{
 const values=namespaces[specifier];if(!values)throw new Error('ZZ TEST unexpected import');
 return new vm.SyntheticModule(Object.keys(values),function(){for(const [name,value]of Object.entries(values))this.setExport(name,value);},{context});
});
try {
 await actual.evaluate();
 try {await actual.namespace.rehearseRestore({serverUrl:'postgresql://localhost/zz_test_admin',structureFile:mode==='unsafe'?source:undefined});} catch {}
 console.log('proof:'+JSON.stringify(proof));
} finally {
 const absolute=path.resolve(fixture),relative=path.relative(path.resolve(os.tmpdir()),absolute);
 if(!relative||relative.startsWith('..')||relative.includes(':')||!relative.startsWith('oto-r8-cross-fixture-'))throw new Error('ZZ TEST fixture cleanup refused');
 fs.rmSync(absolute,{recursive:true,force:true});
}
`;
  const child = spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 20_000,
  });
  expect(child.status, child.stderr).toBe(0);
  const line = child.stdout.split('\n').find((entry) => entry.startsWith('proof:'));
  expect(!!line, 'the isolated probe produced its arrangement proof').toBe(true);
  return JSON.parse(line!.slice('proof:'.length)) as Proof;
}

describe('S2-17b round 8 independent input review', () => {
  const inventory = probe('inventory');
  const unsafe = probe('unsafe');

  it('both controlled probes use a real 184-name baseline and only fake generated databases', () => {
    expect(inventory.baselineCount).toBe(184);
    expect(inventory.sourceCount).toBe(184);
    expect(inventory.hasQuizTable).toBe(true);
    expect(inventory.substituted).toBe(true);
    expect(unsafe.unsafeMarkers).toBe(true);
    for (const proof of [inventory, unsafe]) {
      expect(proof.existingTargetTouched).toBe(false);
      expect(proof.dropped).toBe(proof.created);
    }
    const baseline = readFileSync(`${APP}migrations/0000_otoapp_baseline.sql`, 'utf8');
    expect(baseline.includes('CREATE TABLE "quiz_attempts"')).toBe(true);
  });

  it.fails('FINDING 1 (medium): substituted source tables are refused; prescribed fix: compare every baseline table name before sample seed or baseline adoption', () => {
    expect(inventory.acceptedInventory).toBe(false);
  });

  it.fails('FINDING 2 (high): connection/include/shell markers never reach psql; prescribed fix: validate structure input or load through a fixed SQL client', () => {
    expect(unsafe.acceptedUnsafe).toBe(false);
  });
});
