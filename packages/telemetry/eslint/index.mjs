import noPiiInLogs from './no-pii-in-logs.mjs';

/**
 * An ESLint flat-config plugin. Plain `.mjs` rather than TypeScript on
 * purpose: ESLint loads its config with Node, not with `tsx`, so a rule
 * written in `.ts` would have to be built before it could lint the build.
 *
 * Wire it up in the repository's `eslint.config.mjs`:
 *
 *   import otoTelemetry from './packages/telemetry/eslint/index.mjs';
 *   …
 *   { plugins: { oto: otoTelemetry }, rules: { 'oto/no-pii-in-logs': 'error' } }
 */
const plugin = {
  meta: { name: '@oto/telemetry', version: '0.1.0' },
  rules: { 'no-pii-in-logs': noPiiInLogs },
};

export const rules = plugin.rules;
export default plugin;
