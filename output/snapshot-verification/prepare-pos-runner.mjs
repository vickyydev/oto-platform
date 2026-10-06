import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
const base=import.meta.dirname,out=resolve(base,'../child-review-verification');mkdirSync(out,{recursive:true});
for(const file of ['safe-output.mjs','safe-reporter.mjs'])writeFileSync(resolve(out,file),readFileSync(resolve(base,file),'utf8'));
let config=readFileSync(resolve(base,'console-native.config.mts'),'utf8')
 .replace('../../apps/console/playwright.config.ts','../../apps/pos/playwright.config.ts')
 .replace('../../apps/console/e2e','../../apps/pos/e2e')
 .replace("testMatch: 'console-smoke.spec.ts'","testMatch: 'smoke.spec.ts'");
writeFileSync(resolve(out,'pos-native.config.mts'),config);
let script=readFileSync(resolve(base,'console-run.mjs'),'utf8')
 .replaceAll("apps/console/package.json","apps/pos/package.json")
 .replaceAll('console-native.config.mts','pos-native.config.mts')
 .replaceAll('Native Console runner','Native POS runner')
 .replaceAll('oto_snapshot_console_','oto_child_review_')
 .replaceAll('snapshot-console','child-review-pos')
 .replace("const apiPort = await freePort(); const consolePort = await freePort();","const apiPort = await freePort(); const consolePort = await freePort();\n  const fixture = readFileSync(resolve(repoRoot, 'apps/console/e2e/console.ts'), 'utf8');\n  const fixturePhone = fixture.match(/phone: '([^']+)'/)[1];\n  const fixturePassword = fixture.match(/password: '([^']+)'/)[1];")
 .replaceAll("start own Console","start own POS")
 .replaceAll("cwd: resolve(repoRoot, 'apps/console')","cwd: resolve(repoRoot, 'apps/pos')")
 .replace("CONSOLE_PORT: consolePort","POS_PORT: consolePort")
 .replace("'--grep', 'display snapshots|station-read grant', ","")
 .replace("CONSOLE_E2E_DATABASE_URL: databaseUrl.toString(),\n      CONSOLE_E2E_API_PORT: apiPort, CONSOLE_E2E_PORT: consolePort","SMOKE_BASE_URL: 'http://127.0.0.1:' + consolePort,\n      POS_E2E_PHONE: fixturePhone, POS_E2E_PASSWORD: fixturePassword, POS_E2E_ADMIN_PHONE: fixturePhone, POS_E2E_ADMIN_PASSWORD: fixturePassword,\n      POS_E2E_EVIDENCE_DIR: resolve(runnerRoot, 'evidence', runId)")
 .replace("record.tests.length !== 2","record.tests.length !== 3")
 .replaceAll('two passing existing Console cases','three passing existing POS cases')
 .replaceAll('Two existing Console cases passed.','Three existing POS cases passed.');
writeFileSync(resolve(out,'pos-run.mjs'),script);
