import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runnerRoot, safeError } from './safe-output.mjs';

export default class SafeReporter {
  tests = [];
  errors = [];
  printsToStdio() { return false; }
  onStdOut() {}
  onStdErr() {}
  onError(error) { this.errors.push(safeError(error)); }
  onTestEnd(test, result) {
    this.tests.push({ name: test.title, status: result.status, errors: result.errors.map(safeError) });
  }
  onEnd(result) {
    const runId = process.env.SNAPSHOT_VERIFICATION_RUN;
    if (!runId || !/^[a-z0-9_-]+$/.test(runId)) throw new Error('A safe native run ID is required.');
    writeFileSync(resolve(runnerRoot, `results-${runId}.json`), JSON.stringify({
      status: result.status, tests: this.tests, errors: this.errors,
    }, null, 2) + '\n');
  }
}
