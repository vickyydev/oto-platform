import otoTelemetry from './packages/telemetry/eslint/index.mjs';
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.turbo/**',
      // The lifted OTO App (S2-17a) keeps its own toolchain, its own lockfile
      // and its own style — it is outside the pnpm workspace for the same
      // reason. Holding 184 tables' worth of inherited code to rules it was
      // never written against turns every push red and, because every Render
      // service deploys on `checksPass`, stops the whole suite deploying. Its
      // own `npm run check` is what gates it; the one rule that must not be
      // lost — never write a phone number to a log — is enforced there instead
      // by a vendored copy of the platform's redactor that every log line and
      // every `console.*` call goes through.
      'apps/oto-app/**',
      '**/migrations/**',
      // Raw Replit exports are reference material, never part of the build.
      'imports/**',
      'docs/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Repo tooling scripts run on Node 22 (global fetch/FormData/Blob included).
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        fetch: 'readonly',
        FormData: 'readonly',
        Blob: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        setTimeout: 'readonly',
      },
    },
  },
  {
    // The till's service worker is plain JavaScript that runs in a worker's
    // global, not a page's. `__PRECACHE__` is the placeholder the
    // `otoServiceWorker` plugin in apps/pos/vite.config.ts replaces with the
    // shell's file list at build time.
    files: ['apps/pos/pwa/**/*.js'],
    languageOptions: {
      globals: {
        self: 'readonly',
        caches: 'readonly',
        fetch: 'readonly',
        Request: 'readonly',
        URL: 'readonly',
        __PRECACHE__: 'readonly',
      },
    },
  },
  {
    rules: {
      // `any` requires a justifying comment per engineering standards — surfaced
      // as a warning so the comment + suppression are deliberate.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // The till is linted by the same rules as everything above, plus the two
    // rules of hooks. A hook called conditionally breaks React's call order at
    // run time, so rules-of-hooks is an error. exhaustive-deps is a warning:
    // the till's effects were written before the rule ran, and adding a
    // dependency changes when an effect runs, so each warning is judged by
    // hand - fixed where the new dependency is provably stable or the effect
    // should re-run on it, otherwise kept with a disable comment saying why.
    // Only these two: the plugin's recommended set also turns on its React
    // Compiler checks, which this code was never written against.
    files: ['apps/pos/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // The till's hook tests render against a stand-in for React's own hooks.
    // Its useCallback hands the caller's dependency list straight to its
    // useMemo, which exhaustive-deps reads as a component missing a dependency.
    files: ['apps/pos/test/support/hooks.ts'],
    rules: { 'react-hooks/exhaustive-deps': 'off' },
  },
  {
    // A log line is written once and read when something has already gone
    // wrong, which is the worst moment to discover it carries a phone number
    // or a child's medical note. The redactor in @oto/telemetry catches these
    // at runtime; this catches them at the keyboard, where they are cheap to
    // fix. Deliberately NOT listing : it is the error code on every
    // envelope we send and the SQLSTATE on every pg error, so a rule that
    // fired on it would be switched off within a week - the redactor, which
    // can see the value, still refuses a six-digit one.
    files: ['**/*.ts', '**/*.mjs'],
    plugins: { oto: otoTelemetry },
    rules: { 'oto/no-pii-in-logs': 'error' },
  },
);
