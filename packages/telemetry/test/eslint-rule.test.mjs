import { RuleTester } from 'eslint';
import { it } from 'vitest';
import rule from '../eslint/no-pii-in-logs.mjs';

/**
 * Written in `.mjs` because the rule is: ESLint loads its config with plain
 * Node, so a rule authored in TypeScript could not lint until it had been
 * built, and the test has to import exactly what ESLint will.
 *
 * `RuleTester.run` is called inside a vitest `it` so a mismatch surfaces as a
 * failing test rather than a throw during collection.
 */

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2023, sourceType: 'module' },
});

it('flags personal data in a log object literal and leaves the rest alone', () => {
  ruleTester.run('no-pii-in-logs', rule, {
    valid: [
      "req.log.info({ phoneHash: phoneHash(phone), accountId }, 'sign-in failed');",
      "req.log.info({ op: 'member.create', ms, reqId: req.id }, 'op ok');",
      "app.log.warn({ branchName, jobName, stationName }, 'stale');",
      "logger.error({ err, statusCode: 500 }, 'request failed');",
      // `code` is the error code on every failure line the api writes; the
      // redactor, which can see the value, is what catches a 482913.
      "log.error({ channel, code: info.code }, 'alert delivery failed');",
      // Not a logger: the rule stays out of ordinary code.
      'const body = { phone, name };',
      'res.send({ phone: member.phone });',
      "db.insert(member).values({ phone, name: 'Mali' });",
      // A computed key cannot be read statically; the redactor still catches it.
      'req.log.info({ [key]: value });',
    ],
    invalid: [
      {
        code: 'req.log.info({ phone });',
        errors: [{ messageId: 'pii', data: { key: 'phone' } }],
      },
      {
        code: "req.log.info({ member: { phone: '+66811111111' } }, 'looked up');",
        errors: 1,
      },
      {
        code: 'this.log.error({ child: { allergies, medicalNotes } });',
        errors: 2,
      },
      {
        code: "app.log.child({ name: 'Mali' });",
        errors: 1,
      },
      {
        code: 'console.log({ email: member.email });',
        errors: 1,
      },
      {
        code: 'logger.debug({ rows: [{ phoneNumber: p }] });',
        errors: 1,
      },
      {
        code: "req.log.info({ verificationCode }, 'code sent');",
        errors: 1,
      },
      {
        code: "req.log.info({ 'medical-notes': notes });",
        errors: 1,
      },
    ],
  });
});
