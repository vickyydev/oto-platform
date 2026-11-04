import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const cwd = 'C:/oto-lanes/codex-till-codes-20261104';
assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd, encoding: 'utf8' }).trim(), '');
const receipt = { source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim(), startedAt: new Date().toISOString(), outcome: 'running' };
const file = 'C:/oto-lanes/s747-api-full.json';
writeFileSync(file, JSON.stringify(receipt, null, 2) + '\n');
const child = spawn('C:/Program Files/Git/bin/bash.exe', ['C:/oto-lanes/s747-api-full.sh'], { cwd, windowsHide: true, stdio: 'inherit' });
child.once('exit', (code, signal) => {
  Object.assign(receipt, { exitCode: code ?? 1, signal, finishedAt: new Date().toISOString(), outcome: code === 0 ? 'passed' : 'failed' });
  writeFileSync(file, JSON.stringify(receipt, null, 2) + '\n'); console.log(JSON.stringify(receipt)); process.exitCode = code ?? 1;
});
