import { describe, expect, it } from 'vitest';
import { TestSetupError, describeFailure, setupStep } from '../src/testing';

/**
 * SCRUM-510: a harness step that falls over names itself and its whole cause
 * chain, including the shapes that used to print as "Unknown Error: undefined".
 */
describe('setupStep and describeFailure', () => {
  it('names the step when it rejects with undefined', async () => {
    const err = await setupStep('seed oto_test_x', () => Promise.reject(undefined)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TestSetupError);
    expect((err as Error).message).toBe(
      'test harness step "seed oto_test_x" failed: the step rejected with undefined (no error object, no message)',
    );
  });

  it('prints each member of an AggregateError with its socket fields', () => {
    const refused = (address: string) =>
      Object.assign(new Error(`connect ECONNREFUSED ${address}:5432`), {
        code: 'ECONNREFUSED',
        syscall: 'connect',
        address,
        port: 5432,
      });
    const text = describeFailure(new AggregateError([refused('::1'), refused('127.0.0.1')], ''));
    expect(text).toContain('AggregateError: (empty message)');
    expect(text).toContain('[1/2] Error: connect ECONNREFUSED ::1:5432 [code=ECONNREFUSED syscall=connect address=::1 port=5432]');
    expect(text).toContain('[2/2] Error: connect ECONNREFUSED 127.0.0.1:5432');
  });

  it('follows the cause chain and joins nested steps into one path', async () => {
    const pgError = Object.assign(new Error('too many clients already'), { code: '53300', severity: 'FATAL' });
    const err = await setupStep('build the api', () =>
      setupStep('connect', () => {
        throw new Error('pool connect failed', { cause: pgError });
      }),
    ).catch((e: unknown) => e as TestSetupError);
    expect(err.step).toBe('build the api > connect');
    expect(err.message).toContain('Error: pool connect failed');
    expect(err.message).toContain('caused by: Error: too many clients already [code=53300 severity=FATAL]');
    expect(err.cause).toBeInstanceOf(Error);
  });

  it('keeps what a child process printed', () => {
    const exec = Object.assign(new Error('Command failed: node drizzle-kit migrate'), {
      status: 1,
      stderr: Buffer.from('error: relation "x" already exists\n'),
      stdout: '',
    });
    expect(describeFailure(exec)).toBe(
      'Error: Command failed: node drizzle-kit migrate [status=1]\nstderr:\nerror: relation "x" already exists',
    );
  });
});
