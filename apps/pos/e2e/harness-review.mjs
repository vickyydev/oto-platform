import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { URL } from 'node:url';

const requireDb = createRequire(new URL('../../../packages/db/package.json', import.meta.url));
requireDb('tsx/esm/api').register();
const { default: RequiredCases } = await import('./required-cases.ts');

test('HIGH: an empty selection cannot certify the till; require an executed case', async () => {
  assert.equal((await new RequiredCases().onEnd({ status: 'passed' })).status, 'failed');
});
test('HIGH: missing-fixture skips must fail the gate even beside passing cases', async () => {
  const reporter = new RequiredCases();
  reporter.onTestEnd({}, { status: 'passed' });
  reporter.onTestEnd({}, { status: 'skipped' });
  assert.equal((await reporter.onEnd({ status: 'passed' })).status, 'failed');
});
test('HIGH: a sign-in failure must remain failed; preserve the runner outcome', async () => {
  const reporter = new RequiredCases();
  reporter.onTestEnd({}, { status: 'failed' });
  assert.equal((await reporter.onEnd({ status: 'failed' })).status, 'failed');
});
test('passing executed cases retain green', async () => {
  const reporter = new RequiredCases();
  reporter.onTestEnd({}, { status: 'passed' });
  assert.equal((await reporter.onEnd({ status: 'passed' })).status, 'passed');
});
